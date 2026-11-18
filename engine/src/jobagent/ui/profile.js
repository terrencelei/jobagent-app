// Profile page: view and edit what the application agents know, and the baseline resume printed from it.
(function(){
  const $=id=>document.getElementById(id);
  const el=(tag,props={},...children)=>{const node=document.createElement(tag);for(const [k,v] of Object.entries(props)){if(k==='class')node.className=v;else if(k==='text')node.textContent=v;else if(k in node)node[k]=v;else node.setAttribute(k,v);}node.append(...children);return node;};
  let data=null,resumeEdited=false;
  const dirty=new Map();           // answers key -> new value
  let listsDirty=false;
  const status=(text,kind='')=>{$('status').textContent=text;$('status').className=kind;};
  const refreshBar=()=>{const n=dirty.size+(listsDirty?1:0)+(resumeEdited?1:0);$('save').disabled=$('discard').disabled=!n;if(n)status(`${n===1?'1 unsaved change':`${n} unsaved changes`}.`);else status('No unsaved changes.');};
  window.addEventListener('beforeunload',event=>{if(!$('save').disabled){event.preventDefault();event.returnValue='';}});

  function field(f){
    let input;
    const yesNo=['bool','yesno','yesno-text'].includes(f.kind);
    if(yesNo){input=el('select');if(f.value===null)input.append(el('option',{value:'',text:'Saved copies differ; choose one',disabled:true}));
      for(const [v,t] of [['true','Yes'],['false','No']])input.append(el('option',{value:v,text:t}));
      input.value=f.value===null?'':f.kind==='yesno-text'?String(/^(yes|true)$/i.test(f.value)):String(f.value);}
    else if(f.kind==='json'){input=el('textarea',{value:JSON.stringify(f.value,null,2),spellcheck:false});}
    else if(f.kind==='number'){input=el('input',{type:'number',step:'any',value:f.value});}
    else if(f.kind!=='yesno'&&String(f.value??'').length>70){input=el('textarea',{value:f.value??''});}
    else input=el('input',{type:'text',value:f.value??''});
    input.addEventListener('input',()=>{
      let value;
      try{value=f.kind==='yesno-text'?(input.value==='true'?'Yes':'No'):yesNo?input.value==='true':f.kind==='number'?Number(input.value):f.kind==='json'?JSON.parse(input.value):input.value;input.setCustomValidity('');}
      catch{input.setCustomValidity('This must be valid JSON');input.classList.add('changed');dirty.set(f.key,new Error('invalid'));refreshBar();return;}
      const same=f.kind==='yesno-text'?/^(yes|true)$/i.test(f.value)===(value==='Yes'):JSON.stringify(value)===JSON.stringify(f.value??(f.kind==='text'?'':f.value));
      input.classList.toggle('changed',!same);if(same)dirty.delete(f.key);else dirty.set(f.key,value);refreshBar();
    });
    const label=el('label',{class:(f.kind==='json'||input.tagName==='TEXTAREA'||f.note?'wide':'')+(f.conflict?' conflict':'')},f.label,input);
    if(f.note)label.append(el('small',{text:f.note}));
    return label;
  }
  const monthYear=(pair,onChange)=>{const m=el('input',{type:'number',min:1,max:12,placeholder:'Month',value:pair?.[0]??''}),y=el('input',{type:'number',min:1990,max:2100,placeholder:'Year',value:pair?.[1]??''});
    for(const i of [m,y])i.addEventListener('input',()=>onChange(m.value&&y.value?[String(Number(m.value)),String(Number(y.value))]:null));return el('div',{class:'row',style:'flex-wrap:nowrap'},m,y);};
  function rows(title,note,key,columns,blank){
    const card=el('details',{class:'card',open:key==='workHistory'},el('summary',{},title,el('span',{text:note})));
    const list=el('div');card.append(list);
    const draw=()=>{list.replaceChildren();
      data[key].forEach((row,index)=>{
        const fields=el('div',{class:'fields'});
        for(const [name,label,kind] of columns){
          if(kind==='date'){fields.append(el('label',{},label,monthYear(row[name],v=>{row[name]=v;listsDirty=true;refreshBar();})));continue;}
          const input=kind==='long'?el('textarea',{value:row[name]??''}):el('input',{type:'text',value:row[name]??''});
          input.addEventListener('input',()=>{row[name]=input.value;input.classList.add('changed');listsDirty=true;refreshBar();});
          fields.append(el('label',{class:kind==='long'?'wide':''},label,input));
        }
        const remove=el('button',{type:'button',class:'app-button danger',text:'Remove'});
        remove.addEventListener('click',()=>{data[key].splice(index,1);listsDirty=true;refreshBar();draw();});
        list.append(el('div',{class:'entry'},el('div',{class:'entry-head'},el('h3',{text:row[columns[0][0]]||row[columns[1][0]]||'New entry'}),remove),fields));
      });
      const add=el('button',{type:'button',class:'app-button',text:`Add ${title.toLowerCase().replace(/s$/,'').replace('work history','a job')}`});
      add.addEventListener('click',()=>{data[key].push({...blank});listsDirty=true;refreshBar();draw();card.open=true;});
      list.append(el('div',{class:'row',style:'margin-top:12px'},add));
    };
    draw();return card;
  }
  function drawFacts(){
    const root=$('facts');root.replaceChildren();
    root.append(rows('Work history','titles, places and dates also print on your resume','workHistory',[['company','Company'],['title','Title'],['location','Location'],['from','Started','date'],['to','Ended (leave empty for present)','date'],['description','What you did (agents answer from this)','long']],{company:'',title:'',location:'',from:null,to:null,description:''}));
    root.append(rows('Education','','education',[['school','School'],['degree','Degree'],['field','Field of study'],['from','Started','date'],['to','Graduates','date']],{school:'',degree:'',field:'',from:null,to:null}));
    for(const group of data.groups){
      const fields=el('div',{class:'fields'});for(const f of group.fields)fields.append(field(f));
      root.append(el('details',{class:'card',open:group.id==='about'},el('summary',{},group.title,el('span',{text:`${group.fields.length} saved`})),fields));
    }
  }
  function drawResume(){
    const r=data.resume,s=r.structure,root=$('resumeFields');root.replaceChildren();
    $('resumeMeta').textContent=`${r.file}${r.updated?` · last printed ${new Date(r.updated).toLocaleString()}`:''} · ${r.fit.fits?(r.fit.lines_free?`fits one page with ${r.fit.lines_free} line(s) to spare`:'fills one page exactly'):`${r.fit.lines_over} line(s) too long`}`;
    const pending=$('pending');pending.replaceChildren();pending.hidden=!r.pending.length;
    for(const change of r.pending)pending.append(el('li',{text:`Will update on save: ${change}`}));
    const touch=()=>{resumeEdited=true;refreshBar();};
    const text=(holder,name,label,long)=>{const input=long?el('textarea',{value:holder[name]??''}):el('input',{type:'text',value:holder[name]??''});input.addEventListener('input',()=>{holder[name]=input.value;input.classList.add('changed');touch();});return el('label',{class:long?'wide':''},label,input);};
    const lines=(holder,name,label)=>{const input=el('textarea',{value:(holder[name]||[]).join('\n')});input.addEventListener('input',()=>{holder[name]=input.value.split('\n').map(x=>x.trim()).filter(Boolean);input.classList.add('changed');touch();});return el('label',{class:'wide'},label,input);};
    root.append(el('div',{class:'fields'},text(s,'name','Name as printed'),lines(s,'contact','Contact line (one item per line)')));
    for(const section of s.sections){
      const box=el('div',{class:'entry'},el('h3',{text:section.title}));
      if(section.kind==='skills')for(const line of section.lines)box.append(el('div',{class:'fields'},text(line,'label','Label'),text(line,'text','Skills',true)));
      else for(const entry of section.entries)box.append(el('div',{class:'fields'},text(entry,'org','Organisation'),text(entry,'dates','Dates'),text(entry,'role','Role'),text(entry,'location','Location'),lines(entry,'bullets','Bullets (one per line)')));
      root.append(box);
    }
  }
  async function load(){
    try{const response=await fetch('/api/profile');if(!response.ok)throw new Error((await response.json().catch(()=>({}))).detail||`The server answered ${response.status}`);data=await response.json();}
    catch(error){$('facts').replaceChildren(el('p',{class:'hint',text:`Your profile could not be loaded: ${error.message}. Check that JobAgent is running, then reload.`}));return;}
    dirty.clear();listsDirty=false;resumeEdited=false;drawFacts();drawResume();refreshBar();
  }
  const body=extra=>({resume:resumeEdited?data.resume.structure:null,sync_resume:true,...extra});
  $('previewResume').addEventListener('click',async()=>{
    status('Printing a preview…');
    try{const response=await fetch('/api/profile/resume/preview.png',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body({resume:data.resume.structure}))});
      if(!response.ok)throw new Error((await response.json().catch(()=>({}))).detail||`The server answered ${response.status}`);
      $('resumeImage').src=URL.createObjectURL(await response.blob());status('Preview shown. Nothing is saved yet.');}
    catch(error){status(`Preview failed: ${error.message}`,'error');}
  });
  $('discard').addEventListener('click',()=>{$('resumeImage').src=`/api/profile/resume.png?${Date.now()}`;load();});
  $('save').addEventListener('click',async()=>{
    if([...dirty.values()].some(v=>v instanceof Error)){status('Fix the highlighted JSON field before saving.','error');return;}
    $('save').disabled=true;status('Saving…');
    try{
      const response=await fetch('/api/profile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body({answers:dirty.size?Object.fromEntries(dirty):null,workHistory:listsDirty?data.workHistory:null,education:listsDirty?data.education:null}))});
      const result=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(typeof result.detail==='string'?result.detail:`The server answered ${response.status}`);
      data=result;dirty.clear();listsDirty=false;resumeEdited=false;drawFacts();drawResume();$('resumeImage').src=`/api/profile/resume.png?${Date.now()}`;refreshBar();
      status(`Saved.${result.resume_updated?' Resume re-printed'+(result.resume_changes?.length?` (${result.resume_changes.length} detail(s) updated from your profile)`:'')+'.':' The resume needed no change.'}`,'ok');
    }catch(error){status(`Not saved: ${error.message}`,'error');$('save').disabled=false;}
  });
  load();
})();
