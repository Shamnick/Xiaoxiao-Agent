const test=require('node:test'),assert=require('node:assert/strict');
const {publicAddress,fetchPage}=require('../src/web');
test('web fetch excludes private, mapped, transition and metadata addresses',()=>{
 for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','192.168.1.1','172.20.2.1','100.64.0.1','::1','::ffff:127.0.0.1','2001:db8::1','2002:7f00:1::','fc00::1'])assert.equal(publicAddress(ip),false,ip);
 assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);
});
test('rejects non HTTPS and private literal targets before request',async()=>{
 await assert.rejects(fetchPage('http://example.com'),/公共 HTTPS/);
 await assert.rejects(fetchPage('https://127.0.0.1'),/保留地址/);
 await assert.rejects(fetchPage('https://[::1]'),/保留地址/);
 await assert.rejects(fetchPage('https://user:pass@example.com'),/公共 HTTPS/);
});
