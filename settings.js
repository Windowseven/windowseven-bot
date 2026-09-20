require('dotenv').config();

const settings = {
  packname: process.env.PACK_NAME || 'Windowseven MD',
  author: process.env.PACK_AUTHOR || 'Windowseven',
  botName: process.env.BOT_NAME || 'Windowseven MD',
  botOwner: process.env.BOT_OWNER || 'Windowseven Admin',
  ownerNumber: process.env.OWNER_NUMBER || '', // Transitional fallback only
  giphyApiKey: process.env.GIPHY_API_KEY || '',
  commandMode: process.env.COMMAND_MODE || 'public',
  maxStoreMessages: parseInt(process.env.MAX_STORE_MESSAGES, 10) || 20, 
  storeWriteInterval: parseInt(process.env.STORE_WRITE_INTERVAL, 10) || 10000,
  description: "Windowseven MD - Multi-tenant WhatsApp Bot & Management Platform",
  version: "1.0.0",
};

module.exports = settings;
