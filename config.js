require('dotenv').config();

global.APIs = {
    xteam: process.env.XTEAM_API_URL || 'https://api.xteam.xyz',
    lol: process.env.LOLHUMAN_API_URL || 'https://api.lolhuman.xyz',
    neoxr: process.env.NEOXR_API_URL || 'https://api.neoxr.my.id',
    violetics: process.env.VIOLETICS_API_URL || 'https://violetics.pw',
    zenzapis: process.env.ZENZAPIS_API_URL || 'https://zenzapis.xyz',
    fgmods: process.env.FGMODS_API_URL || 'https://api-fgmods.ddns.net',
    shizo: process.env.SHIZO_API_URL || 'https://shizoapi.onrender.com',
    princetech: process.env.PRINCETECH_API_URL || 'https://api.princetechn.com'
};

global.APIKeys = {
    'https://api.xteam.xyz': process.env.XTEAM_API_KEY || '',
    'https://api.lolhuman.xyz': process.env.LOLHUMAN_API_KEY || '',
    'https://api.neoxr.my.id': process.env.NEOXR_API_KEY || '',
    'https://violetics.pw': process.env.VIOLETICS_API_KEY || '',
    'https://zenzapis.xyz': process.env.ZENZAPIS_API_KEY || '',
    'https://api-fgmods.ddns.net': process.env.FGMODS_API_KEY || '',
    'https://shizoapi.onrender.com': process.env.SHIZO_API_KEY || '',
    'https://api.princetechn.com': process.env.PRINCETECH_API_KEY || ''
};

module.exports = {
    WARN_COUNT: parseInt(process.env.WARN_COUNT, 10) || 3,
    APIs: global.APIs,
    APIKeys: global.APIKeys
};