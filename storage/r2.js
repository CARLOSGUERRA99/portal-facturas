const { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

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

async function listarArchivosR2(prefijo = 'debug/', limite = 50) {
  try {
    const resp = await r2.send(new ListObjectsV2Command({
      Bucket:  process.env.R2_BUCKET,
      Prefix:  prefijo,
      MaxKeys: limite,
    }));
    return (resp.Contents || []).map(obj => ({
      key:    obj.Key,
      url:    `${process.env.R2_PUBLIC_URL}/${obj.Key}`,
      fecha:  obj.LastModified,
      tamaño: obj.Size,
    }));
  } catch (e) {
    console.error('❌ Error listando R2:', e.message);
    return [];
  }
}

module.exports = { subirArchivoR2, borrarArchivoR2, listarArchivosR2 };
