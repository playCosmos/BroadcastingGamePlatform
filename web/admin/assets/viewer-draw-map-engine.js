((root) => {
  "use strict";

  const SCHEMA_VERSION = "viewer-draw-machine-map/v0";
  const TYPES = new Set(["WALL","RAMP","PEG","BUMPER","SPAWN","FINISH","GATE","ROTATOR","PENDULUM","SEESAW","FUNNEL","SPLITTER"]);

  const clamp = (v,min,max) => Math.max(min,Math.min(max,v));
  const degToRad = (deg) => deg * Math.PI / 180;
  const finiteOr = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };

  function rotateLocal(c,x,y){
    const a=degToRad(c.rotation||0),co=Math.cos(a),si=Math.sin(a);
    return {
      x:c.x+x*co-y*si,
      y:c.y+x*si+y*co
    };
  }

  function segmentRect(c,x1,y1,x2,y2,thickness){
    const a=rotateLocal(c,x1,y1);
    const b=rotateLocal(c,x2,y2);
    return {
      ...c,
      x:(a.x+b.x)/2,
      y:(a.y+b.y)/2,
      rotation:Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI,
      width:Math.max(1,Math.hypot(b.x-a.x,b.y-a.y)),
      height:Math.max(2,thickness)
    };
  }

  function motionRotation(c,time=0){
    const p=c.properties||{};
    const base=finiteOr(c.rotation,0);
    const t=Math.max(0,finiteOr(time,0));
    if(c.type==="ROTATOR"){
      return base+clamp(finiteOr(p.angularSpeed,90),-720,720)*t;
    }
    const period=clamp(
      finiteOr(p.period,c.type==="GATE"?3.6:3.2),
      .25,
      30
    );
    const phase=finiteOr(p.phase,0)*Math.PI*2;
    const wave=Math.sin((Math.PI*2*t/period)+phase);
    if(c.type==="GATE"){
      return base+clamp(finiteOr(p.openAngle,78),0,160)*(.5+.5*wave);
    }
    if(c.type==="PENDULUM"){
      return base+clamp(finiteOr(p.amplitude,42),0,120)*wave;
    }
    if(c.type==="SEESAW"){
      return base+clamp(finiteOr(p.amplitude,14),0,120)*wave;
    }
    return base;
  }

  function componentShapes(c,time=0){
    if(["GATE","ROTATOR","PENDULUM","SEESAW"].includes(c.type)){
      return [{...c,rotation:motionRotation(c,time)}];
    }

    const p=c.properties||{};
    const w=Math.max(20,finiteOr(c.width,220));
    const h=Math.max(20,finiteOr(c.height,160));
    const thickness=clamp(finiteOr(p.thickness,14),4,80);

    if(c.type==="FUNNEL"){
      const gap=clamp(finiteOr(p.gap,48),8,Math.max(8,w*.8));
      return [
        segmentRect(c,-w/2,-h/2,-gap/2,h/2,thickness),
        segmentRect(c,w/2,-h/2,gap/2,h/2,thickness)
      ];
    }

    if(c.type==="SPLITTER"){
      return [
        segmentRect(c,0,-h/2,-w/2,h/2,thickness),
        segmentRect(c,0,-h/2,w/2,h/2,thickness)
      ];
    }

    return [c];
  }

  function componentDefaults(type,x=640,y=360){
    const id=(root.crypto?.randomUUID?.() || ("c-"+Date.now()+"-"+Math.random())).replaceAll(".","-");
    const base={id,type,x,y,rotation:0,width:0,height:0,radius:0,properties:{}};
    switch(type){
      case "WALL": return {...base,width:260,height:18,properties:{restitution:0.35,friction:0.06}};
      case "RAMP": return {...base,width:320,height:18,rotation:12,properties:{restitution:0.3,friction:0.05}};
      case "PEG": return {...base,radius:13,properties:{restitution:0.55,friction:0.03}};
      case "BUMPER": return {...base,radius:24,properties:{restitution:0.95,friction:0.02,boost:1.15}};
      case "SPAWN": return {...base,radius:18,properties:{marbleRadius:11}};
      case "FINISH": return {...base,width:260,height:56,properties:{}};
      case "GATE": return {...base,width:180,height:16,properties:{restitution:0.35,friction:0.05,openAngle:78,period:3.6,phase:0}};
      case "ROTATOR": return {...base,width:190,height:16,properties:{restitution:0.42,friction:0.04,angularSpeed:90}};
      case "PENDULUM": return {...base,width:18,height:190,properties:{restitution:0.4,friction:0.05,amplitude:42,period:3.2,phase:0}};
      case "SEESAW": return {...base,width:230,height:16,properties:{restitution:0.34,friction:0.08,amplitude:14,period:4,phase:0}};
      case "FUNNEL": return {...base,width:280,height:190,properties:{restitution:0.3,friction:0.06,gap:52,thickness:14}};
      case "SPLITTER": return {...base,width:220,height:170,properties:{restitution:0.34,friction:0.05,thickness:14}};
      default: throw new Error("Unsupported component type: "+type);
    }
  }

  function defaultDefinition(){
    return {
      schemaVersion:SCHEMA_VERSION,
      name:"New Marble Machine",
      world:{width:1280,height:720,gravityX:0,gravityY:12},
      components:[
        componentDefaults("SPAWN",640,70),
        {...componentDefaults("RAMP",430,215),rotation:12,width:470},
        {...componentDefaults("RAMP",850,360),rotation:-12,width:470},
        componentDefaults("PEG",520,470),
        componentDefaults("BUMPER",690,480),
        componentDefaults("PEG",840,500),
        {...componentDefaults("FINISH",640,660),width:300,height:62}
      ]
    };
  }

  function validateDefinition(def){
    const errors=[];
    if(!def || def.schemaVersion!==SCHEMA_VERSION) errors.push("지원하지 않는 schemaVersion입니다.");
    if(!def?.name?.trim()) errors.push("맵 이름이 필요합니다.");
    const w=Number(def?.world?.width), h=Number(def?.world?.height);
    if(!Number.isFinite(w)||w<320||w>3840||!Number.isFinite(h)||h<240||h>2160){
      errors.push("World 크기는 320~3840 × 240~2160 범위여야 합니다.");
    }
    const gx=Number(def?.world?.gravityX), gy=Number(def?.world?.gravityY);
    if(!Number.isFinite(gx)||!Number.isFinite(gy)||Math.abs(gx)>50||Math.abs(gy)>50){
      errors.push("중력 값은 -50~50 범위여야 합니다.");
    }
    const comps=Array.isArray(def?.components)?def.components:[];
    if(comps.length>500) errors.push("컴포넌트는 최대 500개입니다.");
    const ids=new Set();
    let spawn=0,finish=0;
    for(const c of comps){
      if(!c?.id || ids.has(c.id)) errors.push("컴포넌트 ID는 고유해야 합니다.");
      ids.add(c?.id);
      if(!TYPES.has(c?.type)) errors.push("지원하지 않는 컴포넌트: "+c?.type);
      const x=Number(c?.x),y=Number(c?.y),rotation=Number(c?.rotation);
      if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(rotation)){
        errors.push("컴포넌트 위치/회전 값은 유한 숫자여야 합니다.");
      }else if(x<0||x>w||y<0||y>h){
        errors.push("컴포넌트 기준점은 World 내부여야 합니다.");
      }
      if(["WALL","RAMP","FINISH","GATE","ROTATOR","PENDULUM","SEESAW","FUNNEL","SPLITTER"].includes(c?.type)){
        const cw=Number(c?.width),ch=Number(c?.height);
        if(!Number.isFinite(cw)||!Number.isFinite(ch)||cw<8||ch<2){
          errors.push("사각형/복합 컴포넌트 크기가 유효하지 않습니다.");
        }
      }
      if(["PEG","BUMPER","SPAWN"].includes(c?.type)){
        const radius=Number(c?.radius);
        if(!Number.isFinite(radius)||radius<3||radius>120){
          errors.push("원형 컴포넌트 radius는 3~120 범위여야 합니다.");
        }
      }
      if(c?.type==="FINISH"&&(Number(c?.width)<10||Number(c?.height)<10)){
        errors.push("FINISH 크기는 최소 10×10이어야 합니다.");
      }
      if(c?.type==="SPAWN") spawn++;
      if(c?.type==="FINISH") finish++;
    }
    if(!spawn) errors.push("SPAWN이 최소 1개 필요합니다.");
    if(!finish) errors.push("FINISH가 최소 1개 필요합니다.");
    return [...new Set(errors)];
  }

  function seeded(seed){
    let s=(seed>>>0)||0x6d2b79f5;
    return () => {
      s += 0x6d2b79f5;
      let t=s;
      t=Math.imul(t^(t>>>15),t|1);
      t^=t+Math.imul(t^(t>>>7),t|61);
      return ((t^(t>>>14))>>>0)/4294967296;
    };
  }

  class PreviewEngine {
    constructor(definition,{seed=1}={}){
      this.fixedDt=1/120;
      this.accumulator=0;
      this.time=0;
      this.seed=seed;
      this.random=seeded(seed);
      this.setDefinition(definition);
    }

    setDefinition(definition){
      const errors=validateDefinition(definition);
      if(errors.length) throw new Error(errors.join(" "));
      this.definition=structuredClone(definition);
      this.marbles=[];
      this.finishOrder=[];
      this.accumulator=0;
      this.time=0;
    }

    reset(count=12,seed=this.seed){
      const rng=seeded(seed);
      this.random=rng;
      const spawns=this.definition.components.filter(c=>c.type==="SPAWN");
      const n=clamp(Math.floor(Number(count)||1),1,64);
      this.marbles=[];
      this.finishOrder=[];
      this.accumulator=0;
      this.time=0;

      for(let i=0;i<n;i++){
        const spawn=spawns[i%spawns.length];
        const r=clamp(Number(spawn.properties?.marbleRadius)||11,5,24);
        const ring=Math.floor(i/spawns.length);
        const angle=(i*2.399963229728653)+(rng()-.5)*.2;
        const spread=(ring+1)*Math.min(r*1.5,18);
        this.marbles.push({
          id:"m"+(i+1),
          x:spawn.x+Math.cos(angle)*spread,
          y:spawn.y+Math.sin(angle)*spread,
          vx:(rng()-.5)*35,
          vy:(rng()-.5)*8,
          radius:r,
          finished:false,
          rank:0,
          finishTime:null
        });
      }
      return this.snapshot();
    }

    advance(realDt){
      this.accumulator+=clamp(Number(realDt)||0,0,.05);
      let guard=0;
      while(this.accumulator>=this.fixedDt && guard<12){
        this.step(this.fixedDt);
        this.accumulator-=this.fixedDt;
        guard++;
      }
      return this.snapshot();
    }

    step(dt){
      const world=this.definition.world;
      const gravityScale=80;
      this.time+=dt;

      for(const m of this.marbles){
        if(m.finished) continue;
        m.vx+=world.gravityX*gravityScale*dt;
        m.vy+=world.gravityY*gravityScale*dt;
        m.vx*=0.9995;
        m.vy*=0.9995;
        m.x+=m.vx*dt;
        m.y+=m.vy*dt;

        this.resolveWorldBounds(m,world);
        for(const c of this.definition.components){
          for(const shape of componentShapes(c,this.time)){
            if(["WALL","RAMP","GATE","ROTATOR","PENDULUM","SEESAW","FUNNEL","SPLITTER"].includes(c.type)){
              this.resolveRect(m,shape);
            }else if(c.type==="PEG"||c.type==="BUMPER"){
              this.resolveCircle(m,shape);
            }
          }
        }
      }

      this.resolveMarblePairs();

      const finishes=this.definition.components.filter(c=>c.type==="FINISH");
      for(const m of this.marbles){
        if(m.finished) continue;
        if(finishes.some(f=>this.pointInRect(m.x,m.y,f))){
          m.finished=true;
          m.rank=this.finishOrder.length+1;
          m.finishTime=this.time;
          m.vx=0;m.vy=0;
          this.finishOrder.push(m.id);
        }
      }
    }

    resolveWorldBounds(m,w){
      const e=.42;
      if(m.x<m.radius){m.x=m.radius;if(m.vx<0)m.vx=-m.vx*e;}
      if(m.x>w.width-m.radius){m.x=w.width-m.radius;if(m.vx>0)m.vx=-m.vx*e;}
      if(m.y<m.radius){m.y=m.radius;if(m.vy<0)m.vy=-m.vy*e;}
      if(m.y>w.height-m.radius){m.y=w.height-m.radius;if(m.vy>0)m.vy=-m.vy*e;}
    }

    resolveRect(m,c){
      const a=degToRad(c.rotation||0),co=Math.cos(a),si=Math.sin(a);
      const dx=m.x-c.x,dy=m.y-c.y;
      const lx=dx*co+dy*si, ly=-dx*si+dy*co;
      const hw=Math.max(1,c.width/2),hh=Math.max(1,c.height/2);
      const qx=clamp(lx,-hw,hw),qy=clamp(ly,-hh,hh);
      let nx=lx-qx,ny=ly-qy;
      let dist=Math.hypot(nx,ny);
      let penetration=m.radius-dist;

      if(dist<1e-8){
        const px=hw-Math.abs(lx),py=hh-Math.abs(ly);
        if(px<py){nx=lx>=0?1:-1;ny=0;penetration=m.radius+px;}
        else{nx=0;ny=ly>=0?1:-1;penetration=m.radius+py;}
        dist=1;
      }else{
        nx/=dist;ny/=dist;
      }
      if(penetration<=0) return;

      const wx=nx*co-ny*si, wy=nx*si+ny*co;
      m.x+=wx*penetration;
      m.y+=wy*penetration;
      const vn=m.vx*wx+m.vy*wy;
      if(vn<0){
        const restitution=clamp(finiteOr(c.properties?.restitution,.35),0,1.4);
        m.vx-=(1+restitution)*vn*wx;
        m.vy-=(1+restitution)*vn*wy;
        const friction=clamp(finiteOr(c.properties?.friction,.05),0,.5);
        const tx=-wy,ty=wx,vt=m.vx*tx+m.vy*ty;
        m.vx-=vt*friction*tx;
        m.vy-=vt*friction*ty;
      }
    }

    resolveCircle(m,c){
      let dx=m.x-c.x,dy=m.y-c.y;
      let dist=Math.hypot(dx,dy);
      const target=m.radius+Math.max(1,c.radius);
      if(dist>=target) return;
      if(dist<1e-8){dx=1;dy=0;dist=1;}
      const nx=dx/dist,ny=dy/dist;
      const penetration=target-dist;
      m.x+=nx*penetration;
      m.y+=ny*penetration;
      const vn=m.vx*nx+m.vy*ny;
      if(vn<0){
        const restitution=clamp(
          finiteOr(
            c.properties?.restitution,
            c.type==="BUMPER" ? .95 : .55
          ),
          0,
          1.4
        );
        m.vx-=(1+restitution)*vn*nx;
        m.vy-=(1+restitution)*vn*ny;
      }
      if(c.type==="BUMPER"){
        const boost=clamp(finiteOr(c.properties?.boost,1.15),0,3);
        m.vx+=nx*boost*70;
        m.vy+=ny*boost*70;
      }
    }

    resolveMarblePairs(){
      const ms=this.marbles;
      for(let i=0;i<ms.length;i++){
        const a=ms[i]; if(a.finished) continue;
        for(let j=i+1;j<ms.length;j++){
          const b=ms[j]; if(b.finished) continue;
          let dx=b.x-a.x,dy=b.y-a.y,dist=Math.hypot(dx,dy);
          const target=a.radius+b.radius;
          if(dist>=target) continue;
          if(dist<1e-8){dx=1;dy=0;dist=1;}
          const nx=dx/dist,ny=dy/dist,pen=target-dist;
          a.x-=nx*pen*.5;a.y-=ny*pen*.5;
          b.x+=nx*pen*.5;b.y+=ny*pen*.5;
          const rv=(b.vx-a.vx)*nx+(b.vy-a.vy)*ny;
          if(rv<0){
            const impulse=-(1+.62)*rv/2;
            a.vx-=impulse*nx;a.vy-=impulse*ny;
            b.vx+=impulse*nx;b.vy+=impulse*ny;
          }
        }
      }
    }

    pointInRect(x,y,c){
      const a=degToRad(c.rotation||0),co=Math.cos(a),si=Math.sin(a);
      const dx=x-c.x,dy=y-c.y;
      const lx=dx*co+dy*si,ly=-dx*si+dy*co;
      return Math.abs(lx)<=c.width/2 && Math.abs(ly)<=c.height/2;
    }

    shakeMarble(id){
      const marble=this.marbles.find(m=>m.id===id);
      if(!marble||marble.finished) return false;
      const angle=this.random()*Math.PI*2;
      const power=70+this.random()*50;
      marble.vx+=Math.cos(angle)*power;
      marble.vy+=Math.sin(angle)*power;
      return true;
    }

    snapshot(){
      return {
        time:this.time,
        marbles:this.marbles.map(m=>({...m})),
        finishOrder:[...this.finishOrder],
        finishedCount:this.finishOrder.length,
        totalCount:this.marbles.length
      };
    }
  }

  root.ViewerDrawMapEngine={
    SCHEMA_VERSION,
    componentDefaults,
    defaultDefinition,
    validateDefinition,
    componentShapes,
    motionRotation,
    PreviewEngine
  };
})(globalThis);
