const {execFileSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path');
if(process.platform!=='darwin')throw Error('请在 macOS 生成 icns 图标');
const dir=path.resolve('build/icon.iconset');fs.mkdirSync(dir,{recursive:true});
for(const size of [16,32,128,256,512])for(const scale of [1,2]){
  const pixels=size*scale,file=path.join(dir,'icon_'+size+'x'+size+(scale===2?'@2x':'')+'.png');
  execFileSync('sips',['-s','format','png','-z',String(pixels),String(pixels),'src/brand.svg','--out',file],{stdio:'ignore'});
}
execFileSync('iconutil',['-c','icns',dir,'-o','build/icon.icns']);
