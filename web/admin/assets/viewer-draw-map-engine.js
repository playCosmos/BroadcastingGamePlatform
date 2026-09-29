((root) => {
  "use strict";

  const SCHEMA_VERSION = "viewer-draw-machine-map/v0";
  const TYPES = new Set(["WALL","RAMP","PEG","BUMPER","SPAWN","FINISH"]);

  const clamp = (v,min,max) => Math.max(min,Math.min(max,v));
  const degToRad = (deg) => deg * Math.PI / 180;
  const finiteOr = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };

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
          if(c.type==="WALL"||c.type==="RAMP") this.resolveRect(m,c);
          else if(c.type==="PEG"||c.type==="BUMPER") this.resolveCircle(m,c);
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
    PreviewEngine
  };
})(globalThis);
