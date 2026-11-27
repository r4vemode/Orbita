export const validLegalVersion=value=>typeof value==='string'&&/^ORBITA-[A-Za-z0-9.-]{1,100}$/.test(value);
function flag(env,name){
  const value=env[name];if(value===undefined||value===''||value==='false'||value==='0')return false;
  if(value==='true'||value==='1')return true;
  throw Error(name+': используйте true или false.');
}
export function createSalesGate({legal,env=process.env}={}){
  const enabled=flag(env,'ORBITA_LIVE_PAYMENTS_ENABLED'),receipts=flag(env,'ORBITA_RECEIPTS_CONFIRMED');
  return async({acceptedVersion}={})=>{
    const historical=acceptedVersion!==undefined;
    if(historical&&(!enabled||!receipts||!validLegalVersion(acceptedVersion)))return {ready:false};
    let publication;
    try{publication=historical?await legal?.readPublic({version:acceptedVersion}):await legal?.readPublic();}
    catch(cause){if(historical&&cause?.status===404)return {ready:false};throw cause;}
    return {ready:enabled&&receipts&&publication?.published===true&&validLegalVersion(publication.version)&&(!historical||publication.version===acceptedVersion),legalVersion:publication?.version};
  };
}
