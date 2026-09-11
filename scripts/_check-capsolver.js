require('dotenv').config();
console.log('CAPSOLVER_API_KEY:', process.env.CAPSOLVER_API_KEY ? 'DEFINIDA (' + process.env.CAPSOLVER_API_KEY.slice(0, 8) + '...)' : 'NO DEFINIDA');
