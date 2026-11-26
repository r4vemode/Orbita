import {plainText} from '../model.mjs';

const months=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const pad=value=>String(value).padStart(2,'0');

export function russianPressDay(markup){
 const value=plainText(markup,140).toLowerCase().replace(/\s+/g,' ').replace(/\s*г\.?$/u,'');
 const numeric=value.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
 const written=value.match(/^(\d{1,2}) ([а-я]+) (\d{4})$/u);
 if(!numeric&&!written)return null;
 const number=written?months.indexOf(written[2])+1:Number(numeric[2]);
 if(number<1||number>12)return null;
 const match=numeric||written;
 const day=match[3]+'-'+pad(number)+'-'+pad(match[1]);
 const stamp=new Date(day+'T00:00:00Z');
 return Number.isFinite(stamp.getTime())&&stamp.toISOString().startsWith(day+'T')?day:null;
}
