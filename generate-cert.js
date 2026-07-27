// 生成自签名 HTTPS 证书（用于本地开发）
// 用法: node generate-cert.js
// 证书会包含本机所有 IPv4 / IPv6 地址，方便用 IP 直接访问
const selfsigned = require('selfsigned');
const fs = require('fs');
const path = require('path');
const os = require('os');

const certDir = path.join(__dirname, 'cert');
if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir, { recursive: true });
}

// 收集本机所有非内网 IPv4 / IPv6 地址，加入证书 SAN
const altNames = [
    { type: 2, value: 'localhost' },   // DNS: localhost
    { type: 7, ip: '127.0.0.1' },      // IP: IPv4 本机回环
    { type: 7, ip: '::1' }              // IP: IPv6 本机回环
];
const ifaces = os.networkInterfaces();
for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
        if (iface.internal) continue;
        if (iface.family === 'IPv4') {
            altNames.push({ type: 7, ip: iface.address });
        } else if (iface.family === 'IPv6') {
            // 去掉 IPv6 地址中的 zone id（如 fe80::xxx%eth0）
            const addr = iface.address.split('%')[0];
            altNames.push({ type: 7, ip: addr });
        }
    }
}

console.log('证书将包含以下主体备用名称（SAN）:');
altNames.forEach(n => {
    if (n.type === 2) console.log('  - DNS: ' + n.value);
    else if (n.type === 7) console.log('  - IP : ' + n.ip);
});

// 为 localhost 和所有本机 IP 生成自签名证书（365 天有效）
selfsigned
    .generate([{ name: 'commonName', value: 'localhost' }], {
        keySize: 2048,
        algorithm: 'sha256',
        extensions: [
            { name: 'basicConstraints', cA: false },
            { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
            { name: 'extKeyUsage', serverAuth: true },
            { name: 'subjectAltName', altNames: altNames }
        ]
    })
    .then((pems) => {
        fs.writeFileSync(path.join(certDir, 'key.pem'), pems.private);
        fs.writeFileSync(path.join(certDir, 'cert.pem'), pems.cert);
        console.log('HTTPS 证书已生成到 cert/ 目录（key.pem 和 cert.pem）');
        console.log('提示: 本机 IP 变化后需重新运行此脚本以更新证书。');
    })
    .catch((e) => {
        console.error('生成证书失败:', e);
        process.exit(1);
    });
