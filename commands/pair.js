const axios = require('axios');
const { sleep } = require('../lib/myfunc');

async function pairCommand(sock, chatId, message, q) {
    try {
        if (!q) {
            return await sock.sendMessage(chatId, {
                text: "Please provide a valid WhatsApp number\nExample: .pair 255712345678"
            }, { quoted: message });
        }

        const numbers = q.split(',')
            .map((v) => v.replace(/[^0-9]/g, ''))
            .filter((v) => v.length > 5 && v.length < 20);

        if (numbers.length === 0) {
            return await sock.sendMessage(chatId, {
                text: "Invalid number❌️ Please use the international format without '+' or spaces."
            }, { quoted: message });
        }

        const pairServiceUrl = process.env.PAIR_CODE_SERVICE_URL;

        for (const number of numbers) {
            const whatsappID = number + '@s.whatsapp.net';
            const result = await sock.onWhatsApp(whatsappID);

            if (!result[0]?.exists) {
                return await sock.sendMessage(chatId, {
                    text: `That number is not registered on WhatsApp❗️`
                }, { quoted: message });
            }

            if (!pairServiceUrl) {
                return await sock.sendMessage(chatId, {
                    text: "⚠️ Pair code service is not configured (missing PAIR_CODE_SERVICE_URL)."
                }, { quoted: message });
            }

            await sock.sendMessage(chatId, {
                text: "Requesting pairing code, please wait..."
            }, { quoted: message });

            try {
                const response = await axios.get(`${pairServiceUrl}/code?number=${number}`, { timeout: 15000 });
                
                if (response.data && response.data.code) {
                    const code = response.data.code;
                    if (code === "Service Unavailable") {
                        throw new Error('Service Unavailable');
                    }
                    
                    await sleep(2000);
                    await sock.sendMessage(chatId, {
                        text: `Your pairing code: ${code}`
                    }, { quoted: message });
                } else {
                    throw new Error('Invalid response from server');
                }
            } catch (apiError) {
                console.error('API Error in pair command:', apiError.message || apiError);
                await sock.sendMessage(chatId, {
                    text: "Failed to generate pairing code. Please try again later."
                }, { quoted: message });
            }
        }
    } catch (error) {
        console.error('Error in pair command:', error);
        await sock.sendMessage(chatId, {
            text: "An error occurred while generating pair code."
        }, { quoted: message });
    }
}

module.exports = pairCommand;