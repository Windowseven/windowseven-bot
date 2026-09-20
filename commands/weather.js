const axios = require('axios');

module.exports = async function (sock, chatId, message, city) {
    try {
        const apiKey = process.env.OPENWEATHER_API_KEY;
        if (!apiKey) {
            await sock.sendMessage(chatId, { text: '⚠️ Weather service is currently not configured (missing OPENWEATHER_API_KEY).' }, { quoted: message });
            return;
        }
        if (!city) {
            await sock.sendMessage(chatId, { text: 'Please specify a city. Example: .weather London' }, { quoted: message });
            return;
        }
        const response = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric`);
        const weather = response.data;
        const weatherText = `Weather in ${weather.name}: ${weather.weather[0]?.description || 'clear'}. Temperature: ${weather.main?.temp}°C.`;
        await sock.sendMessage(chatId, { text: weatherText }, { quoted: message });
    } catch (error) {
        console.error('Error fetching weather:', error.message || error);
        await sock.sendMessage(chatId, { text: 'Sorry, I could not fetch the weather for that location.' }, { quoted: message });
    }
};
