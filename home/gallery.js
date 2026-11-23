(() => {
  'use strict';
  const root = document.querySelector('.community-gallery');
  const stage = root.querySelector('.gallery-stage');
  const controls = root.querySelector('.gallery-controls');
  const status = root.querySelector('[data-gallery-status]');
  const captions = [
    'Players gathered in a chandelier-lit hall','A player at the front of a wood-paneled chamber',
    'A grove lit by purple crystals at night','Osprey’s waterfront hall at sunset',
    'Players posing on the temple steps','A gathering around a red carpet',
    'A poster beside a city street','Looking through a wooden hall toward the sunset',
    'A view into a circular stone arena','A player climbing an enormous block statue',
    'An illuminated Osprey sign beside a columned building','Firelight on a tower at night',
    'A room filled with colorful crystals','A domed building with purple rings above it',
    'An airship floating above a tower','A dark tower reflected in the water at dusk',
    'Players by the water after dark','A tower and a cross on a sunlit ridge',
    'A farmhouse surrounded by terraced crops','Amethyst lighting a stone passage',
    'Purple crystals above a wooded courtyard','A narrow timber-lined passage lit by sunlight'
  ];
  const archived = [
    [2,'A hillside town with cherry trees and waterfalls'],[3,'Buildings beneath a glowing amethyst canopy'],
    [4,'A council chamber with players in the gallery'],[7,'A city skyline with towers and rising smoke'],
    [8,'A BlackStone poster with a market chart and gold blocks'],[9,'A BlackStone poster with a laser-eyed figure'],
    [10,'An Oasis poster with a player and a gold block']
  ];
  const photos = [...captions.map((alt,i)=>['new',i+1,alt]),...archived.map(([i,alt])=>['original',i,alt])];
  for(let i=photos.length-1;i>0;i--) {
    const j=Math.floor(Math.random()*(i+1)); [photos[i],photos[j]]=[photos[j],photos[i]];
  }
  const mod=(n,m)=>(n%m+m)%m;
  const nodes=photos.map(([type,id,alt])=>{
    const img=new Image(); img.alt=alt; img.hidden=true; img.draggable=false; img.decoding='async';
    img.dataset.src=`./gallery/${type}-${String(id).padStart(2,'0')}.webp`;
    stage.append(img); return img;
  });
  const reduce=matchMedia('(prefers-reduced-motion: reduce)');
  let playing=!reduce.matches, phase=0, last=0, raf=0, watching=false, hover=false, glide=null;
  const N=nodes.length, cycle=8000;
  // Dwell gently at each whole position without stopping or jumping at the wrap.
  const eased=n=>n-.86*Math.sin(2*Math.PI*n)/(2*Math.PI);
  function paint() {
    const p=eased(phase), center=mod(Math.round(p),N), width=stage.clientWidth;
    nodes.forEach((img,i)=>{
      const d=mod(i-p+N/2,N)-N/2, a=Math.abs(d);
      if(a>3.15){img.hidden=true;return;}
      if(!img.hasAttribute('src')) img.src=img.dataset.src;
      img.hidden=false;
      const theta=d*.62, depth=(1+Math.cos(theta))/2;
      const x=Math.sin(theta)*width*(width<600?.67:.52);
      const y=(1-depth)*-Math.min(75,width*.055);
      const scale=1-.76*(1-depth)-.19*Math.min(1,a);
      img.style.transform=`translate(-50%,-50%) translate(${x}px,${y}px) perspective(900px) rotateY(${-Math.sin(theta)*25}deg) scale(${scale})`;
      img.style.zIndex=String(Math.round(depth*1000));
      img.style.opacity=String(Math.max(0,Math.min(1,(3.15-a)/.55))*(1-.43*(1-depth)-.11*Math.min(1,a)));
      img.style.filter=`blur(${Math.min(2,Math.max(0,a-.12)*1.18)}px)`;
      img.setAttribute('aria-hidden',String(i!==center));
    });
  }
  function frame(now) {
    raf=0;
    if(!watching||document.hidden){last=0;return;}
    if(glide){
      const t=Math.min(1,(now-glide.start)/420);
      phase=glide.from+(glide.to-glide.from)*(1-(1-t)**3);
      if(t===1)glide=null;
    } else if(playing&&!hover&&last)phase=mod(phase+Math.min(now-last,90)/cycle,N);
    paint(); last=now;
    if(glide||(playing&&!hover))raf=requestAnimationFrame(frame);
  }
  function wake(){last=0;if(!raf)raf=requestAnimationFrame(frame);}
  function state(){
    const b=controls.querySelector('[data-action=play]');
    b.dataset.playing=String(playing);
    b.title=playing?'Pause rotation':'Play rotation';
    b.setAttribute('aria-label',b.title);
  }
  function step(dir){
    playing=false;state();
    const to=Math.round(glide?glide.to:eased(phase))+dir;
    if(reduce.matches){phase=to;glide=null;}else glide={from:phase,to,start:performance.now()};
    status.textContent=photos[mod(to,N)][2];paint();wake();
  }
  controls.addEventListener('click',e=>{
    const action=e.target.closest('button')?.dataset.action;
    if(action==='play'){playing=!playing;state();wake();}
    else if(action)step(action==='next'?1:-1);
  });
  controls.addEventListener('keydown',e=>{
    if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();step(e.key==='ArrowRight'?1:-1);}
  });
  stage.addEventListener('pointerenter',e=>{if(e.pointerType==='mouse'){hover=true;wake();}});
  stage.addEventListener('pointerleave',()=>{hover=false;wake();});
  let touchX;
  stage.addEventListener('pointerdown',e=>{if(e.pointerType!=='mouse')touchX=e.clientX;});
  stage.addEventListener('pointerup',e=>{if(touchX!=null&&Math.abs(e.clientX-touchX)>35)step(e.clientX<touchX?1:-1);touchX=null;});
  stage.addEventListener('pointercancel',()=>{touchX=null;});
  reduce.addEventListener('change',()=>{if(reduce.matches){playing=false;phase=Math.round(phase);glide=null;state();paint();wake();}});
  document.addEventListener('visibilitychange',wake);
  new ResizeObserver(paint).observe(stage);
  new IntersectionObserver(([entry])=>{watching=entry.isIntersecting;wake();}).observe(root);
  stage.querySelector('.gallery-poster').remove();controls.hidden=false;
  state();paint();
})();
