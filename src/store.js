const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
class Store {
  constructor(root){this.root=root;fs.mkdirSync(root,{recursive:true,mode:0o700});}
  read(name,fallback){try{return JSON.parse(fs.readFileSync(path.join(this.root,name+'.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw Error('无法读取 '+name+'，请检查本地数据文件');}}
  remove(name) { fs.rmSync(path.join(this.root, name + '.json'), { force: true }); }
  write(name,value){
    const file=path.join(this.root,name+'.json'),tmp=file+'.'+randomUUID();
    fs.writeFileSync(tmp,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});
    try{fs.renameSync(tmp,file);}finally{fs.rmSync(tmp,{force:true});}
  }
}
module.exports={Store};
