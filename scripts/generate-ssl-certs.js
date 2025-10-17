const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const certsDir = path.join(__dirname, '..', 'certs');

// Create certs directory if it doesn't exist
if (!fs.existsSync(certsDir)) {
  fs.mkdirSync(certsDir, { recursive: true });
}

console.log('Generating SSL certificates for development...');

try {
  // Generate private key
  execSync('openssl genrsa -out certs/server.key 2048', { stdio: 'inherit' });
  
  // Generate certificate signing request
  execSync('openssl req -new -key certs/server.key -out certs/server.csr -subj "/C=US/ST=State/L=City/O=Organization/CN=localhost"', { stdio: 'inherit' });
  
  // Generate self-signed certificate
  execSync('openssl x509 -req -days 365 -in certs/server.csr -signkey certs/server.key -out certs/server.crt', { stdio: 'inherit' });
  
  // Clean up CSR file
  fs.unlinkSync(path.join(certsDir, 'server.csr'));
  
  console.log('✅ SSL certificates generated successfully!');
  console.log('📁 Certificates saved to:', certsDir);
  console.log('🔐 Private key: server.key');
  console.log('📜 Certificate: server.crt');
  
} catch (error) {
  console.error('❌ Error generating SSL certificates:', error.message);
  console.log('💡 Make sure OpenSSL is installed on your system');
  console.log('   Windows: Download from https://slproweb.com/products/Win32OpenSSL.html');
  console.log('   macOS: brew install openssl');
  console.log('   Linux: sudo apt-get install openssl');
}
