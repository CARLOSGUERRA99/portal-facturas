const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const r2 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});

async function subirArchivoR2(buffer, key, contentType) {
  try {
    const fileName = key.split('/').pop();
    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      ContentDisposition: `attachment; filename="${fileName}"`,
    }));
    const url = `${process.env.R2_PUBLIC_URL}/${key}`;
    console.log('☁️ Subido a R2:', url);
    return url;
  } catch (e) {
    console.error('❌ Error subiendo a R2:', e.message);
    return null;
  }
}

async function borrarArchivoR2(key) {
  try {
    await r2.send(new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
    }));
    console.log('🗑️ Borrado de R2:', key);
    return true;
  } catch (e) {
    console.error('❌ Error borrando de R2:', e.message);
    return false;
  }
}

module.exports = { subirArchivoR2, borrarArchivoR2 };
