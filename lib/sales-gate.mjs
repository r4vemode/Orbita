export const validLegalVersion=value=>typeof value==='string'&&/^ORBITA-[A-Za-z0-9.-]{1,100}$/.test(value);
function flag(env,name){
  const value=env[name];if(value===undefined||value===''||value==='false'||value==='0')return false;
  if(value==='true'||value==='1')return true;
  throw Error(name+': используйте true или false.');
}
export function createSalesGate({legal,env=process.env}={}){
  const enabled=flag(env,'ORBITA_LIVE_PAYMENTS_ENABLED'),receipts=flag(env,'ORBITA_RECEIPTS_CONFIRMED');
  return async()=>{
    const publication=await legal?.readPublic();
    return {ready:enabled&&receipts&&publication?.published===true&&validLegalVersion(publication.version),legalVersion:publication?.version};
  };
}
