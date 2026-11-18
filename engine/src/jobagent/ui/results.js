// Results flow chart: applications on the left, each outcome to the right, band width in proportion to its count.
(async function(){
  const notice=document.getElementById('notice'),svg=document.getElementById('chart'),NS='http://www.w3.org/2000/svg';
  // One fixed colour per outcome, so a stage looks the same every time.
  const colour={'Applications':'#8c8377','No answer yet':'#e08a8a','Rejected':'#f0a35c','Withdrawn by me':'#a98572','Interviewed':'#5f86b8','Interviewing':'#63b3a9','Rejected after interview':'#f0a35c','Withdrawn after interview':'#a98572','Offer received':'#6bb36b'};
  let data;
  try{const response=await fetch('/api/results');if(!response.ok)throw new Error(`The server answered ${response.status}`);data=await response.json();}
  catch(error){notice.textContent=`Results could not be loaded: ${error.message}. Check that JobAgent is running, then reload.`;return;}
  if(!data.total){notice.textContent='No applications have been recorded yet. Results appear here after the first one is submitted.';return;}
  notice.hidden=true;
  // Every outcome gets at least the height of its two-line label, so small counts stay readable beside a large one.
  const W=1100,H=600,pad=20,nodeW=18,gap=12,slot=50,minH=4;
  const firstColumn=data.links.filter(l=>l.from==='Applications');
  const scale=(H-pad*2-gap*(firstColumn.length-1)-slot*firstColumn.length)/data.total;
  svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
  const el=(name,attrs,parent=svg)=>{const node=document.createElementNS(NS,name);for(const [k,v] of Object.entries(attrs))node.setAttribute(k,v);parent.append(node);return node;};
  const depth={'Applications':0};
  for(let pass=0;pass<4;pass++)for(const link of data.links)if(depth[link.from]!=null)depth[link.to]=Math.max(depth[link.to]??0,depth[link.from]+1);
  const x=d=>pad+90+d*((W-pad*2-90-260)/Math.max(1,Math.max(...Object.values(depth))));
  const size=v=>Math.max(minH,v*scale);
  const nodes={};
  const room=v=>Math.max(slot,size(v));
  const place=(name,value,top)=>{nodes[name]={x:x(depth[name]),y:top+(room(value)-size(value))/2,h:size(value),value,used:0};return top+room(value)+gap;};
  place('Applications',data.total,(H-size(data.total))/2);
  for(let d=1;d<=Math.max(...Object.values(depth));d++){
    const column=data.links.filter(l=>depth[l.to]===d);
    const total=column.reduce((sum,l)=>sum+room(l.value)+gap,-gap);
    const parents=[...new Set(column.map(l=>l.from))].map(n=>nodes[n]);
    const centre=parents.reduce((s,n)=>s+n.y+n.h/2,0)/parents.length;
    let top=Math.min(H-pad-total,Math.max(pad,(d===1?H/2:centre)-total/2));
    for(const link of column)top=place(link.to,link.value,top);
  }
  for(const link of data.links){
    const a=nodes[link.from],b=nodes[link.to],h=Math.max(minH,link.value*scale),y0=a.y+a.used,x0=a.x+nodeW,x1=b.x,mid=(x0+x1)/2;
    a.used+=link.value*scale;
    const band=el('path',{d:`M${x0},${y0} C${mid},${y0} ${mid},${b.y} ${x1},${b.y} L${x1},${b.y+b.h} C${mid},${b.y+b.h} ${mid},${y0+h} ${x0},${y0+h} Z`,fill:colour[link.to]||'#999','fill-opacity':.55});
    el('title',{},band).textContent=`${link.from} → ${link.to}: ${link.value}`;
  }
  for(const [name,node] of Object.entries(nodes)){
    el('rect',{x:node.x,y:node.y,width:nodeW,height:node.h,rx:3,fill:colour[name]||'#999'});
    const left=name==='Applications',tx=left?node.x-10:node.x+nodeW+12,ty=node.y+node.h/2;
    el('text',{x:tx,y:ty-6,'text-anchor':left?'end':'start',class:'node-name'}).textContent=name;
    el('text',{x:tx,y:ty+20,'text-anchor':left?'end':'start',class:'node-count'}).textContent=node.value;
  }
  const table=document.getElementById('chartTable');
  table.innerHTML='<tr><th>Stage</th><th>Applications</th></tr>';
  for(const [name,node] of Object.entries(nodes)){const row=table.insertRow();row.insertCell().textContent=name;row.insertCell().textContent=node.value;}
})();
