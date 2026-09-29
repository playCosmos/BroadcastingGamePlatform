((root) => {
  "use strict";

  const SCHEMA_VERSION = "viewer-draw-machine-map/v0";
  const TYPES = new Set(["WALL","RAMP","PEG","BUMPER","SPAWN","FINISH","GATE","ROTATOR","PENDULUM","SEESAW","FUNNEL","SPLITTER","HINGE","GEAR","PADDLE","LAUNCHER","ELEVATOR","OUTPUT","SLOT","ELIMINATION"]);

  const clamp = (v,min,max) => Math.max(min,Math.min(max,v));
  const degToRad = (deg) => deg * Math.PI / 180;
  const finiteOr = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };

  function resolvedDrawRule(def){
    const raw=def?.drawRule||{};
    const type=String(raw.type||"RACE_FINISH").toUpperCase();
    const winnerCount=Math.max(0,Math.trunc(finiteOr(raw.winnerCount,0)));
    return {type,winnerCount};
  }

  function elevatorPosition(c,time=0){
    const p=c.properties||{};
    const min=clamp(finiteOr(p.travelMin,-120),-1200,1200);
    const max=clamp(finiteOr(p.travelMax,120),-1200,1200);
    const lower=Math.min(min,max),upper=Math.max(min,max);
    const span=Math.max(1,upper-lower);
    const speed=clamp(Math.abs(finiteOr(p.motorSpeed,90)),1,600);
    const t=Math.max(0,finiteOr(time,0));
    const start=clamp(0,lower,upper);
    const direction=finiteOr(p.startDirection,1)<0?-1:1;
    const origin=direction>0 ? start-lower : upper-start;
    const distance=(origin+t*speed)%(span*2);
    const offset=distance<=span
      ? lower+distance
      : upper-(distance-span);
    const axis=degToRad(finiteOr(p.axisAngle,-90));
    return {
      x:c.x+Math.cos(axis)*offset,
      y:c.y+Math.sin(axis)*offset
    };
  }

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
    const runtimeRotation=Number(c.runtimeRotation);
    if(Number.isFinite(runtimeRotation)) return runtimeRotation;
    const base=finiteOr(c.rotation,0);
    const t=Math.max(0,finiteOr(time,0));
    if(["ROTATOR","GEAR","PADDLE"].includes(c.type)){
      const fallback=c.type==="GEAR" ? 120 : c.type==="PADDLE" ? 180 : 90;
      return base+clamp(finiteOr(p.motorSpeed ?? p.angularSpeed,fallback),-720,720)*t;
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
    if(["GATE","ROTATOR","PENDULUM","SEESAW","PADDLE"].includes(c.type)){
      return [{...c,rotation:motionRotation(c,time)}];
    }
    if(c.type==="HINGE"){
      return [{...c,rotation:motionRotation(c,time)}];
    }
    if(c.type==="GEAR"){
      const rotation=motionRotation(c,time);
      return [
        {...c,rotation},
        {...c,rotation:rotation+90}
      ];
    }
    if(c.type==="ELEVATOR"){
      const position=elevatorPosition(c,time);
      return [{...c,...position}];
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
      case "HINGE": return {...base,width:220,height:16,properties:{restitution:0.34,friction:0.08,pivotRatio:0,lowerAngle:-70,upperAngle:70,jointFriction:1.2}};
      case "GEAR": return {...base,width:170,height:18,properties:{restitution:0.4,friction:0.06,motorSpeed:120,motorTorque:35,linkedComponentId:"",gearRatio:-1}};
      case "PADDLE": return {...base,width:180,height:18,properties:{restitution:0.45,friction:0.06,pivotRatio:-0.48,motorSpeed:180,motorTorque:30}};
      case "LAUNCHER": return {...base,width:140,height:22,properties:{restitution:0.4,friction:0.05,launchPower:1.2}};
      case "ELEVATOR": return {...base,width:180,height:20,properties:{restitution:0.34,friction:0.08,axisAngle:-90,travelMin:-120,travelMax:120,motorSpeed:90,motorForce:45,startDirection:1}};
      case "OUTPUT": return {...base,width:180,height:60,properties:{outputKey:"OUT1",outputRank:1,outputCapacity:1,outputWeight:1}};
      case "SLOT": return {...base,width:180,height:70,properties:{slotKey:"SLOT1",slotCapacity:1}};
      case "ELIMINATION": return {...base,width:180,height:70,properties:{eliminationKey:"OUT"}};
      default: throw new Error("Unsupported component type: "+type);
    }
  }

  function defaultDefinition(){
    return {
      schemaVersion:SCHEMA_VERSION,
      name:"New Marble Machine",
      world:{width:1280,height:720,gravityX:0,gravityY:12},
      drawRule:{type:"RACE_FINISH",winnerCount:0},
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
    const rule=resolvedDrawRule(def);
    if(![
      "RACE_FINISH",
      "ORDERED_OUTPUT",
      "SLOT_COLLECTION",
      "LAST_SURVIVOR",
      "CASCADE_SELECTION",
      "RANDOM_OUTPUT_BUCKET"
    ].includes(rule.type)){
      errors.push("지원하지 않는 drawRule type입니다.");
    }
    if(rule.winnerCount<0||rule.winnerCount>64){
      errors.push("drawRule winnerCount는 0~64 범위여야 합니다.");
    }
    const ids=new Set();
    const typeById=new Map();
    const outputKeys=new Set();
    const outputRanks=new Set();
    const slotKeys=new Set();
    const eliminationKeys=new Set();
    let spawn=0,finish=0,output=0,slot=0,elimination=0;
    let totalOutputCapacity=0,totalSlotCapacity=0;
    for(const c of comps){
      if(!c?.id || ids.has(c.id)) errors.push("컴포넌트 ID는 고유해야 합니다.");
      ids.add(c?.id);
      if(c?.id) typeById.set(c.id,c?.type);
      if(!TYPES.has(c?.type)) errors.push("지원하지 않는 컴포넌트: "+c?.type);
      const x=Number(c?.x),y=Number(c?.y),rotation=Number(c?.rotation);
      if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(rotation)){
        errors.push("컴포넌트 위치/회전 값은 유한 숫자여야 합니다.");
      }else if(x<0||x>w||y<0||y>h){
        errors.push("컴포넌트 기준점은 World 내부여야 합니다.");
      }
      if(["WALL","RAMP","FINISH","GATE","ROTATOR","PENDULUM","SEESAW","FUNNEL","SPLITTER","HINGE","GEAR","PADDLE","LAUNCHER","ELEVATOR","OUTPUT","SLOT","ELIMINATION"].includes(c?.type)){
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
      const p=c?.properties||{};
      if(["HINGE","PADDLE"].includes(c?.type)){
        const pivot=finiteOr(p.pivotRatio,c?.type==="PADDLE"?-.48:0);
        if(pivot<-.5||pivot>.5) errors.push("pivotRatio는 -0.5~0.5 범위여야 합니다.");
      }
      if(c?.type==="HINGE"){
        const lower=finiteOr(p.lowerAngle,-70),upper=finiteOr(p.upperAngle,70);
        const damping=finiteOr(p.jointFriction,1.2);
        if(lower<-180||upper>180||lower>upper) errors.push("Hinge angle limit이 유효하지 않습니다.");
        if(damping<0||damping>50) errors.push("Hinge jointFriction은 0~50 범위여야 합니다.");
      }
      if(["GEAR","PADDLE"].includes(c?.type)){
        const speed=finiteOr(p.motorSpeed,c?.type==="GEAR"?120:180);
        const torque=finiteOr(p.motorTorque,c?.type==="GEAR"?35:30);
        if(speed<-720||speed>720) errors.push("motorSpeed는 -720~720 범위여야 합니다.");
        if(torque<0||torque>200) errors.push("motorTorque는 0~200 범위여야 합니다.");
      }
      if(c?.type==="LAUNCHER"){
        const power=finiteOr(p.launchPower,1.2);
        if(power<0||power>5) errors.push("Launcher launchPower는 0~5 범위여야 합니다.");
      }
      if(c?.type==="GEAR"){
        const linked=String(p.linkedComponentId||"").trim();
        const ratio=finiteOr(p.gearRatio,-1);
        if(linked===c.id) errors.push("Gear는 자기 자신과 연결할 수 없습니다.");
        if(Math.abs(ratio)<.01||Math.abs(ratio)>20) errors.push("gearRatio 절대값은 0.01~20 범위여야 합니다.");
      }
      if(c?.type==="ELEVATOR"){
        const axis=finiteOr(p.axisAngle,-90);
        const min=finiteOr(p.travelMin,-120),max=finiteOr(p.travelMax,120);
        const speed=finiteOr(p.motorSpeed,90),force=finiteOr(p.motorForce,45);
        const direction=finiteOr(p.startDirection,1);
        if(axis<-360||axis>360) errors.push("Elevator axisAngle은 -360~360 범위여야 합니다.");
        if(min<-1200||max>1200||min>=max) errors.push("Elevator travel 범위가 유효하지 않습니다.");
        if(speed<1||speed>600) errors.push("Elevator motorSpeed는 1~600 px/s 범위여야 합니다.");
        if(force<0||force>500) errors.push("Elevator motorForce는 0~500 범위여야 합니다.");
        if(direction!==1&&direction!==-1) errors.push("Elevator startDirection은 -1 또는 1이어야 합니다.");
      }
      if(c?.type==="OUTPUT"){
        const key=String(p.outputKey||"").trim();
        const rank=Math.trunc(finiteOr(p.outputRank,0));
        const capacity=Math.trunc(finiteOr(p.outputCapacity,1));
        const weight=finiteOr(p.outputWeight,1);
        if(!key||key.length>32) errors.push("Output outputKey는 1~32자여야 합니다.");
        if(outputKeys.has(key)) errors.push("Output outputKey는 고유해야 합니다.");
        outputKeys.add(key);
        if(rank<1||rank>64) errors.push("Output outputRank는 1~64 범위여야 합니다.");
        if(rule.type==="ORDERED_OUTPUT"&&outputRanks.has(rank)) errors.push("ORDERED_OUTPUT outputRank는 고유해야 합니다.");
        outputRanks.add(rank);
        if(capacity<1||capacity>64) errors.push("Output outputCapacity는 1~64 범위여야 합니다.");
        if(weight<=0||weight>100) errors.push("Output outputWeight는 0 초과 100 이하이어야 합니다.");
        totalOutputCapacity+=Math.max(0,capacity);
        output++;
      }
      if(c?.type==="SLOT"){
        const key=String(p.slotKey||"").trim();
        const capacity=Math.trunc(finiteOr(p.slotCapacity,1));
        if(!key||key.length>32) errors.push("Slot slotKey는 1~32자여야 합니다.");
        if(slotKeys.has(key)) errors.push("Slot slotKey는 고유해야 합니다.");
        slotKeys.add(key);
        if(capacity<1||capacity>64) errors.push("Slot slotCapacity는 1~64 범위여야 합니다.");
        totalSlotCapacity+=Math.max(0,capacity);
        slot++;
      }
      if(c?.type==="ELIMINATION"){
        const key=String(p.eliminationKey||"").trim();
        if(!key||key.length>32) errors.push("Elimination eliminationKey는 1~32자여야 합니다.");
        if(eliminationKeys.has(key)) errors.push("Elimination eliminationKey는 고유해야 합니다.");
        eliminationKeys.add(key);
        elimination++;
      }

      const material=String(p.soundMaterial||"metal").toLowerCase();
      const instrument=String(p.instrument||"none").toLowerCase();
      const note=finiteOr(p.audioNote,60);
      const gain=finiteOr(p.audioGain,1);
      const pan=finiteOr(p.audioPan,0);
      if(!["metal","wood","glass","rubber","plastic","stone"].includes(material)){
        errors.push("soundMaterial이 유효하지 않습니다.");
      }
      if(!["none","bell","chime","xylophone","drum","click"].includes(instrument)){
        errors.push("instrument가 유효하지 않습니다.");
      }
      if(note<24||note>108) errors.push("audioNote는 MIDI 24~108 범위여야 합니다.");
      if(gain<0||gain>2) errors.push("audioGain은 0~2 범위여야 합니다.");
      if(pan<-1||pan>1) errors.push("audioPan은 -1~1 범위여야 합니다.");

      if(c?.type==="SPAWN") spawn++;
      if(c?.type==="FINISH") finish++;
    }

    for(const c of comps){
      if(c?.type!=="GEAR") continue;
      const linked=String(c?.properties?.linkedComponentId||"").trim();
      if(!linked) continue;
      const targetType=typeById.get(linked);
      if(!targetType){
        errors.push("Gear linkedComponentId 대상이 존재하지 않습니다.");
      }else if(!["GEAR","HINGE","PADDLE","ELEVATOR"].includes(targetType)){
        errors.push("Gear는 joint 기반 컴포넌트에만 연결할 수 있습니다.");
      }
    }

    if(!spawn) errors.push("SPAWN이 최소 1개 필요합니다.");
    if(rule.type==="RACE_FINISH"&&!finish){
      errors.push("RACE_FINISH에는 FINISH가 최소 1개 필요합니다.");
    }
    if(rule.type==="ORDERED_OUTPUT"){
      const winners=rule.winnerCount||output;
      if(!output) errors.push("ORDERED_OUTPUT에는 OUTPUT이 최소 1개 필요합니다.");
      if(winners<1||winners>output) errors.push("ORDERED_OUTPUT winnerCount가 OUTPUT 수보다 클 수 없습니다.");
      for(let rank=1;rank<=winners;rank++){
        if(!outputRanks.has(rank)) errors.push("ORDERED_OUTPUT은 1부터 winnerCount까지 연속 outputRank가 필요합니다.");
      }
    }
    if(rule.type==="SLOT_COLLECTION"){
      const winners=rule.winnerCount||totalSlotCapacity;
      if(!slot) errors.push("SLOT_COLLECTION에는 SLOT이 최소 1개 필요합니다.");
      if(winners<1||winners>totalSlotCapacity) errors.push("SLOT_COLLECTION winnerCount가 Slot 총 capacity를 초과할 수 없습니다.");
    }
    if(rule.type==="LAST_SURVIVOR"){
      const winners=rule.winnerCount||1;
      if(!elimination) errors.push("LAST_SURVIVOR에는 ELIMINATION이 최소 1개 필요합니다.");
      if(winners<1||winners>64) errors.push("LAST_SURVIVOR winnerCount는 1~64여야 합니다.");
    }
    if(rule.type==="CASCADE_SELECTION"){
      const winners=rule.winnerCount||totalOutputCapacity;
      if(!output) errors.push("CASCADE_SELECTION에는 OUTPUT이 최소 1개 필요합니다.");
      if(winners<1||winners>totalOutputCapacity) errors.push("CASCADE_SELECTION winnerCount가 Output 총 capacity를 초과할 수 없습니다.");
    }
    if(rule.type==="RANDOM_OUTPUT_BUCKET"){
      const winners=rule.winnerCount||1;
      if(!output) errors.push("RANDOM_OUTPUT_BUCKET에는 OUTPUT이 최소 1개 필요합니다.");
      if(winners<1||winners>64) errors.push("RANDOM_OUTPUT_BUCKET winnerCount는 1~64여야 합니다.");
      if(output>0){
        const capacities=comps
          .filter(c=>c?.type==="OUTPUT")
          .map(c=>Math.trunc(finiteOr(c?.properties?.outputCapacity,1)));
        if(capacities.some(capacity=>capacity<winners)){
          errors.push("RANDOM_OUTPUT_BUCKET의 모든 Output capacity는 winnerCount 이상이어야 합니다.");
        }
      }
    }
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
      this.outputClaims=new Map();
      this.slotClaims=new Map();
      this.eliminationOrder=[];
      this.selectedOutputKey=null;
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
      this.outputClaims=new Map();
      this.slotClaims=new Map();
      this.eliminationOrder=[];
      this.selectedOutputKey=null;
      this.accumulator=0;
      this.time=0;

      const rule=resolvedDrawRule(this.definition);
      if(rule.type==="RANDOM_OUTPUT_BUCKET"){
        const outputs=this.definition.components.filter(c=>c.type==="OUTPUT");
        const total=outputs.reduce((sum,c)=>sum+Math.max(.0001,finiteOr(c.properties?.outputWeight,1)),0);
        let pick=rng()*total;
        for(const output of outputs){
          pick-=Math.max(.0001,finiteOr(output.properties?.outputWeight,1));
          if(pick<=0){
            this.selectedOutputKey=String(output.properties?.outputKey||"");
            break;
          }
        }
        if(!this.selectedOutputKey&&outputs.length){
          this.selectedOutputKey=String(outputs.at(-1).properties?.outputKey||"");
        }
      }

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
          eliminated:false,
          rank:0,
          finishTime:null,
          launcherContacts:new Set()
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
            if(["WALL","RAMP","GATE","ROTATOR","PENDULUM","SEESAW","FUNNEL","SPLITTER","HINGE","GEAR","PADDLE","LAUNCHER","ELEVATOR"].includes(c.type)){
              this.resolveRect(m,shape);
            }else if(c.type==="PEG"||c.type==="BUMPER"){
              this.resolveCircle(m,shape);
            }
          }
        }
      }

      this.resolveMarblePairs();
      this.applyLauncherBoosts();

      this.detectResultSensors();
    }

    completeMarble(m,rank){
      m.finished=true;
      m.rank=rank;
      m.finishTime=this.time;
      m.vx=0;m.vy=0;
    }

    detectResultSensors(){
      const rule=resolvedDrawRule(this.definition);
      const active=this.marbles.filter(m=>!m.finished&&!m.eliminated);

      if(rule.type==="ORDERED_OUTPUT"){
        const outputs=this.definition.components.filter(c=>c.type==="OUTPUT");
        for(const m of active){
          const output=outputs.find(o=>
            !this.outputClaims.has(Math.trunc(finiteOr(o.properties?.outputRank,0)))
            && this.pointInRect(m.x,m.y,o)
          );
          if(!output) continue;
          const rank=Math.trunc(finiteOr(output.properties?.outputRank,1));
          this.outputClaims.set(rank,m.id);
          this.completeMarble(m,rank);
        }
        this.finishOrder=[...this.outputClaims.entries()]
          .sort((a,b)=>a[0]-b[0])
          .map(([,id])=>id);
        return;
      }

      if(rule.type==="SLOT_COLLECTION"){
        const slots=this.definition.components.filter(c=>c.type==="SLOT");
        const target=rule.winnerCount||slots.reduce((sum,c)=>sum+Math.trunc(finiteOr(c.properties?.slotCapacity,1)),0);
        for(const m of active){
          if(this.finishOrder.length>=target) break;
          const slot=slots.find(candidate=>{
            const key=String(candidate.properties?.slotKey||candidate.id);
            const claims=this.slotClaims.get(key)||[];
            return claims.length<Math.trunc(finiteOr(candidate.properties?.slotCapacity,1))
              && this.pointInRect(m.x,m.y,candidate);
          });
          if(!slot) continue;
          const key=String(slot.properties?.slotKey||slot.id);
          const claims=this.slotClaims.get(key)||[];
          claims.push(m.id);
          this.slotClaims.set(key,claims);
          this.finishOrder.push(m.id);
          this.completeMarble(m,this.finishOrder.length);
        }
        return;
      }

      if(rule.type==="LAST_SURVIVOR"){
        const zones=this.definition.components.filter(c=>c.type==="ELIMINATION");
        const winners=rule.winnerCount||1;
        let remaining=active.length;
        for(const m of active){
          if(remaining<=winners) break;
          if(!zones.some(zone=>this.pointInRect(m.x,m.y,zone))) continue;
          m.eliminated=true;
          m.vx=0;m.vy=0;
          this.eliminationOrder.push(m.id);
          remaining--;
        }
        const survivors=this.marbles.filter(m=>!m.finished&&!m.eliminated);
        if(survivors.length>0&&survivors.length<=winners&&!this.finishOrder.length){
          survivors.sort((a,b)=>{
            const gx=finiteOr(this.definition.world.gravityX,0);
            const gy=finiteOr(this.definition.world.gravityY,0);
            return (b.x*gx+b.y*gy)-(a.x*gx+a.y*gy);
          });
          survivors.forEach((m,index)=>{
            this.finishOrder.push(m.id);
            this.completeMarble(m,index+1);
          });
        }
        return;
      }

      if(rule.type==="CASCADE_SELECTION"){
        const outputs=this.definition.components.filter(c=>c.type==="OUTPUT");
        const target=rule.winnerCount||outputs.reduce((sum,c)=>sum+Math.trunc(finiteOr(c.properties?.outputCapacity,1)),0);
        for(const m of active){
          if(this.finishOrder.length>=target) break;
          const output=outputs.find(candidate=>{
            const key=String(candidate.properties?.outputKey||candidate.id);
            const claims=this.outputClaims.get(key)||[];
            return Array.isArray(claims)
              && claims.length<Math.trunc(finiteOr(candidate.properties?.outputCapacity,1))
              && this.pointInRect(m.x,m.y,candidate);
          });
          if(!output) continue;
          const key=String(output.properties?.outputKey||output.id);
          const claims=this.outputClaims.get(key)||[];
          claims.push(m.id);
          this.outputClaims.set(key,claims);
          this.finishOrder.push(m.id);
          this.completeMarble(m,this.finishOrder.length);
        }
        return;
      }

      if(rule.type==="RANDOM_OUTPUT_BUCKET"){
        const outputs=this.definition.components.filter(c=>
          c.type==="OUTPUT"
          && String(c.properties?.outputKey||"")===this.selectedOutputKey
        );
        const output=outputs[0];
        if(!output) return;
        const target=rule.winnerCount||1;
        for(const m of active){
          if(this.finishOrder.length>=target) break;
          if(!this.pointInRect(m.x,m.y,output)) continue;
          this.finishOrder.push(m.id);
          this.completeMarble(m,this.finishOrder.length);
        }
        return;
      }

      const finishes=this.definition.components.filter(c=>c.type==="FINISH");
      for(const m of active){
        if(finishes.some(f=>this.pointInRect(m.x,m.y,f))){
          this.finishOrder.push(m.id);
          this.completeMarble(m,this.finishOrder.length);
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

    applyLauncherBoosts(){
      const launchers=this.definition.components.filter(c=>c.type==="LAUNCHER");
      if(!launchers.length) return;
      for(const m of this.marbles){
        if(m.finished) continue;
        const next=new Set();
        for(const launcher of launchers){
          if(!this.pointInRectExpanded(m.x,m.y,launcher,m.radius+2)) continue;
          next.add(launcher.id);
          if(m.launcherContacts.has(launcher.id)) continue;
          const power=clamp(finiteOr(launcher.properties?.launchPower,1.2),0,5);
          const angle=degToRad((launcher.rotation||0)-90);
          m.vx+=Math.cos(angle)*power*145;
          m.vy+=Math.sin(angle)*power*145;
        }
        m.launcherContacts=next;
      }
    }

    pointInRectExpanded(x,y,c,pad=0){
      const a=degToRad(c.rotation||0),co=Math.cos(a),si=Math.sin(a);
      const dx=x-c.x,dy=y-c.y;
      const lx=dx*co+dy*si,ly=-dx*si+dy*co;
      return Math.abs(lx)<=c.width/2+pad && Math.abs(ly)<=c.height/2+pad;
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
        marbles:this.marbles.map(m=>({
          id:m.id,x:m.x,y:m.y,vx:m.vx,vy:m.vy,radius:m.radius,
          finished:m.finished,eliminated:m.eliminated,rank:m.rank,finishTime:m.finishTime
        })),
        finishOrder:[...this.finishOrder],
        winnerOrder:[...this.finishOrder],
        outputClaims:[...this.outputClaims.entries()].map(([key,value])=>({key,value})),
        slotClaims:[...this.slotClaims.entries()].map(([key,ids])=>({key,ids:[...ids]})),
        eliminationOrder:[...this.eliminationOrder],
        selectedOutputKey:this.selectedOutputKey,
        finishedCount:this.finishOrder.length,
        targetCount:(()=>{
          const rule=resolvedDrawRule(this.definition);
          if(rule.type==="ORDERED_OUTPUT") return rule.winnerCount||this.definition.components.filter(c=>c.type==="OUTPUT").length;
          if(rule.type==="SLOT_COLLECTION") return rule.winnerCount||this.definition.components.filter(c=>c.type==="SLOT").reduce((sum,c)=>sum+Math.trunc(finiteOr(c.properties?.slotCapacity,1)),0);
          if(rule.type==="LAST_SURVIVOR") return rule.winnerCount||1;
          if(rule.type==="CASCADE_SELECTION") return rule.winnerCount||this.definition.components.filter(c=>c.type==="OUTPUT").reduce((sum,c)=>sum+Math.trunc(finiteOr(c.properties?.outputCapacity,1)),0);
          if(rule.type==="RANDOM_OUTPUT_BUCKET") return rule.winnerCount||1;
          return this.marbles.length;
        })(),
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
    resolvedDrawRule,
    elevatorPosition,
    PreviewEngine
  };
})(globalThis);
