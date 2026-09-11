require('dotenv').config();
console.log('BROWSERLESS_TOKEN definido:', !!process.env.BROWSERLESS_TOKEN);
console.log('Primeros 10 chars:', process.env.BROWSERLESS_TOKEN ? process.env.BROWSERLESS_TOKEN.slice(0,10) : 'N/A');
