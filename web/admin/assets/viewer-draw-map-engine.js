((root) => {
  "use strict";

  const LEGACY_SCHEMA_VERSION = "viewer-draw-machine-map/v0";
  const SCHEMA_VERSION = "viewer-draw-machine-map/v1";
  const TYPES = new Set([
    "WALL","CURVE_WALL","CIRCLE",
    "SPAWN","BURST_SPAWN","FINISH",
    "GATE","ROTATOR","PENDULUM","SEESAW",
    "HINGE","PADDLE",
    "CONVEYOR","ELEVATOR",
    "OUTPUT","SLOT","ELIMINATION"
  ]);
  const RECT_COLLIDER_TYPES = new Set([
    "WALL","GATE","ROTATOR","PENDULUM","SEESAW",
    "HINGE","PADDLE","CONVEYOR","ELEVATOR"
  ]);
  const COLLIDER_TYPES = new Set([
    ...RECT_COLLIDER_TYPES,
    "CURVE_WALL",
    "CIRCLE"
  ]);

  const clamp = (v,min,max) => Math.max(min,Math.min(max,v));
  const degToRad = (deg) => deg * Math.PI / 180;
  const finiteOr = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const colliderProperties = (
    overrides = {},
    defaults = {restitution:.35, friction:.05}
  ) => ({
    restitution:finiteOr(
      overrides.restitution,
      finiteOr(defaults.restitution,.35)
    ),
    friction:finiteOr(
      overrides.friction,
      finiteOr(defaults.friction,.05)
    ),
    boost:Math.max(0,finiteOr(overrides.boost,0)),
    ...overrides
  });
  const isCollider = (component) =>
    Boolean(component && COLLIDER_TYPES.has(component.type));
  const isRectCollider = (component) =>
    Boolean(component && (
      RECT_COLLIDER_TYPES.has(component.type)
      || component.type === "CURVE_WALL"
    ));

  function resolvedDrawRule(def){
    const raw=def?.drawRule||{};
    const type=String(raw.type||"RACE_FINISH").toUpperCase();
    const winnerCount=Math.max(0,Math.trunc(finiteOr(raw.winnerCount,0)));
    return {type,winnerCount};
  }

  function resolvedRunPolicy(def){
    const raw=def?.runPolicy||{};
    return {
      timeoutSeconds:clamp(finiteOr(raw.timeoutSeconds,0),0,1800),
      qualificationMinWinners:clamp(
        Math.trunc(finiteOr(raw.qualificationMinWinners,0)),
        0,
        64
      ),
      qualificationMaxNudges:clamp(
        Math.trunc(finiteOr(raw.qualificationMaxNudges,0)),
        0,
        1000
      )
    };
  }

  function targetCountForDefinition(def){
    const rule=resolvedDrawRule(def);
    const comps=Array.isArray(def?.components)?def.components:[];
    if(rule.type==="RACE_FINISH"&&rule.winnerCount>0){
      return rule.winnerCount;
    }
    if(rule.type==="ORDERED_OUTPUT"){
      return rule.winnerCount||comps.filter(c=>c.type==="OUTPUT").length;
    }
    if(rule.type==="SLOT_COLLECTION"){
      return rule.winnerCount||comps
        .filter(c=>c.type==="SLOT")
        .reduce((sum,c)=>sum+Math.trunc(finiteOr(c.properties?.slotCapacity,1)),0);
    }
    if(rule.type==="LAST_SURVIVOR"){
      return rule.winnerCount||1;
    }
    if(["CASCADE_SELECTION","CONDITIONAL_OUTPUT"].includes(rule.type)){
      return rule.winnerCount||comps
        .filter(c=>c.type==="OUTPUT")
        .reduce((sum,c)=>sum+Math.trunc(finiteOr(c.properties?.outputCapacity,1)),0);
    }
    if(rule.type==="RANDOM_OUTPUT_BUCKET"){
      return rule.winnerCount||1;
    }
    return Number.POSITIVE_INFINITY;
  }

  function conditionalOutputActive(output,definition,context={}){
    const p=output?.properties||{};
    const mode=String(p.conditionType||"ALWAYS").toUpperCase();
    const threshold=clamp(
      Math.trunc(finiteOr(p.conditionClaims,1)),
      1,
      64
    );
    const outputs=(definition?.components||[]).filter(
      c=>c?.type==="OUTPUT"
    );
    const outputClaims=context.outputClaims instanceof Map
      ? context.outputClaims
      : new Map();
    const sensorClaims=context.sensorClaims instanceof Map
      ? context.sensorClaims
      : new Map();
    const branchStates=context.branchStates instanceof Map
      ? context.branchStates
      : new Map();
    const time=Math.max(0,finiteOr(context.time,0));
    if(mode==="ALWAYS") return true;

    const claimCount=(key)=>{
      const value=outputClaims.get(key);
      return Array.isArray(value) ? value.length : value ? 1 : 0;
    };

    if(mode==="AFTER_ANY_CLAIM"){
      let total=0;
      for(const value of outputClaims.values()){
        total+=Array.isArray(value)?value.length:(value?1:0);
      }
      return total>=threshold;
    }

    if(mode==="AFTER_SECONDS"){
      return time>=clamp(finiteOr(p.conditionSeconds,1),.01,1800);
    }

    if(mode==="AFTER_SENSOR_CLAIMS"){
      const tag=String(p.conditionSensorTag||"").trim();
      return tag
        ? (sensorClaims.get(tag)?.size||0)>=threshold
        : false;
    }

    if(mode==="AFTER_BRANCH_STATE"){
      const key=String(p.conditionBranchKey||"").trim();
      const value=String(p.conditionBranchValue||"ON").trim();
      return key
        ? String(branchStates.get(key)??"")===value
        : false;
    }

    const targetKey=String(p.conditionOutputKey||"").trim();
    if(!targetKey) return false;
    const target=outputs.find(c=>
      String(c.properties?.outputKey||"")===targetKey
    );
    if(!target) return false;
    if(mode==="AFTER_OUTPUT_CLAIMS"){
      return claimCount(targetKey)>=threshold;
    }
    if(mode==="AFTER_OUTPUT_FULL"){
      return claimCount(targetKey)>=Math.trunc(
        finiteOr(target.properties?.outputCapacity,1)
      );
    }
    return false;
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
    if(["ROTATOR","PADDLE"].includes(c.type)){
      const fallback=c.type==="PADDLE" ? 180 : 90;
      return base+finiteOr(
        p.motorSpeed ?? p.angularSpeed,
        fallback
      )*t;
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
    if(c.type==="ROTATOR"){
      const rotation=motionRotation(c,time);
      const bladeCount=Math.max(
        1,
        Math.min(
          4,
          Math.trunc(finiteOr(c.properties?.bladeCount,1))
        )
      );
      return Array.from(
        {length:bladeCount},
        (_,index)=>({
          ...c,
          rotation:rotation+(180/bladeCount)*index
        })
      );
    }
    if(["GATE","PENDULUM","SEESAW","PADDLE"].includes(c.type)){
      return [{...c,rotation:motionRotation(c,time)}];
    }
    if(c.type==="HINGE"){
      return [{...c,rotation:motionRotation(c,time)}];
    }
    if(c.type==="ELEVATOR"){
      const position=elevatorPosition(c,time);
      return [{...c,...position}];
    }

    const p=c.properties||{};
    if(c.type==="CURVE_WALL"){
      const w=Math.max(40,finiteOr(c.width,260));
      const h=Math.max(20,finiteOr(c.height,120));
      const thickness=clamp(finiteOr(p.thickness,18),4,80);
      const segments=clamp(Math.trunc(finiteOr(p.segments,16)),6,32);
      const points=[];
      for(let i=0;i<=segments;i++){
        const t=i/segments;
        const omt=1-t;
        const x=omt*omt*(-w/2)+2*omt*t*0+t*t*(w/2);
        const y=omt*omt*(h/2)+2*omt*t*(-h/2)+t*t*(h/2);
        points.push({x,y});
      }
      return points.slice(0,-1).map((point,index)=>
        segmentRect(
          c,
          point.x,
          point.y,
          points[index+1].x,
          points[index+1].y,
          thickness
        )
      );
    }
    return [c];
  }

  function legacyCompoundShapes(c){
    const p=c?.properties||{};
    const w=Math.max(20,finiteOr(c?.width,220));
    const h=Math.max(20,finiteOr(c?.height,160));
    const thickness=clamp(finiteOr(p.thickness,14),4,80);
    if(c?.type==="FUNNEL"){
      const gap=clamp(finiteOr(p.gap,48),8,Math.max(8,w*.8));
      return [
        segmentRect(c,-w/2,-h/2,-gap/2,h/2,thickness),
        segmentRect(c,w/2,-h/2,gap/2,h/2,thickness)
      ];
    }
    if(c?.type==="SPLITTER"){
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
      case "WALL": return {
        ...base,
        width:260,
        height:18,
        properties:colliderProperties({}, {restitution:.35,friction:.06})
      };
      case "CURVE_WALL": return {
        ...base,
        width:280,
        height:140,
        properties:colliderProperties(
          {thickness:18,segments:16},
          {restitution:.35,friction:.06}
        )
      };
      case "CIRCLE": return {
        ...base,
        radius:13,
        properties:colliderProperties({}, {restitution:.55,friction:.03})
      };
      case "SPAWN": return {...base,radius:18,properties:{marbleRadius:11,spawnRole:"BUNCH"}};
      case "BURST_SPAWN": return {...base,radius:26,properties:{
        marbleRadius:11,
        spawnRole:"BURST",
        burstDirectionDegrees:-90,
        burstSpreadDegrees:24,
        burstPower:1.15,
        burstPowerVariance:.22,
        burstSizeMin:3,
        burstSizeMax:7,
        burstIntervalMs:90
      }};
      case "FINISH": return {...base,width:260,height:56,properties:{sensorTag:""}};
      case "GATE": return {...base,width:180,height:16,properties:colliderProperties(
        {openAngle:78,period:3.6,phase:0},
        {restitution:.35,friction:.05}
      )};
      case "ROTATOR": return {...base,width:190,height:16,properties:colliderProperties(
        {angularSpeed:90,bladeCount:1},
        {restitution:.42,friction:.04}
      )};
      case "PENDULUM": return {...base,width:18,height:190,properties:colliderProperties(
        {amplitude:42,period:3.2,phase:0},
        {restitution:.4,friction:.05}
      )};
      case "SEESAW": return {...base,width:230,height:16,properties:colliderProperties(
        {amplitude:14,period:4,phase:0},
        {restitution:.34,friction:.08}
      )};
      case "HINGE": return {...base,width:220,height:16,properties:colliderProperties(
        {pivotRatio:0,lowerAngle:-70,upperAngle:70,jointFriction:1.2},
        {restitution:.34,friction:.08}
      )};
      case "PADDLE": return {...base,width:180,height:18,properties:colliderProperties(
        {pivotRatio:-.48,motorSpeed:180,motorTorque:30},
        {restitution:.45,friction:.06}
      )};
      case "CONVEYOR": return {...base,width:280,height:28,properties:colliderProperties(
        {beltSpeed:160,beltGrip:.22},
        {restitution:.12,friction:.45}
      )};
      case "ELEVATOR": return {...base,width:180,height:20,properties:colliderProperties(
        {axisAngle:-90,travelMin:-120,travelMax:120,motorSpeed:90,motorForce:45,startDirection:1},
        {restitution:.34,friction:.08}
      )};
      case "OUTPUT": return {...base,width:180,height:60,properties:{
        outputKey:"OUT1",outputRank:1,outputCapacity:1,outputWeight:1,
        outputPriority:0,sensorTag:"",
        conditionType:"ALWAYS",conditionOutputKey:"",conditionClaims:1,
        conditionSeconds:1,conditionSensorTag:"",
        conditionBranchKey:"",conditionBranchValue:"ON",
        branchSetKey:"",branchSetValue:"ON"
      }};
      case "SLOT": return {...base,width:180,height:70,properties:{slotKey:"SLOT1",slotCapacity:1,sensorTag:""}};
      case "ELIMINATION": return {...base,width:180,height:70,properties:{eliminationKey:"OUT",sensorTag:""}};
      default: throw new Error("Unsupported component type: "+type);
    }
  }

  function createPreset(name,x=640,y=360){
    const preset=String(name||"").toUpperCase();
    if(preset==="WALL") return componentDefaults("WALL",x,y);
    if(preset==="PEG"){
      const c=componentDefaults("CIRCLE",x,y);
      c.radius=13;
      c.properties=colliderProperties(
        {
          restitution:.55,
          friction:.03,
          boost:0,
          visualFill:"#d0d6db",
          visualStroke:"#f5f7f8"
        },
        {restitution:.55,friction:.03}
      );
      return c;
    }
    if(preset==="BUMPER"){
      const c=componentDefaults("CIRCLE",x,y);
      c.radius=24;
      c.properties=colliderProperties(
        {
          restitution:.95,
          friction:.02,
          boost:1.15,
          visualFill:"#8f3d46",
          visualStroke:"#e17a84"
        },
        {restitution:.95,friction:.02}
      );
      return c;
    }
    if(preset==="LAUNCH_WALL"){
      const c=componentDefaults("WALL",x,y);
      c.width=140;
      c.height=22;
      c.properties=colliderProperties(
        {
          restitution:.4,
          friction:.05,
          boost:1.35,
          visualFill:"#3e6675",
          visualStroke:"#78bdd5"
        },
        {restitution:.4,friction:.05}
      );
      return c;
    }
    return componentDefaults(preset,x,y);
  }

  function migratedColliderProperties(properties,defaults={}){
    return colliderProperties({...properties},defaults);
  }

  function migrateDefinition(input){
    const source=structuredClone(input||{});
    const version=String(source.schemaVersion||"");
    if(version!==LEGACY_SCHEMA_VERSION && version!==SCHEMA_VERSION){
      return source;
    }

    const migrated=[];
    for(const original of Array.isArray(source.components)?source.components:[]){
      if(!original) continue;
      const c=structuredClone(original);
      c.properties=c.properties||{};
      if(
        c.type==="SPAWN"
        && String(c.properties.spawnRole||"").toUpperCase()==="LAUNCHER"
      ){
        c.properties.spawnRole="BURST";
      }

      if(c.type==="RAMP"){
        c.type="WALL";
        c.properties=migratedColliderProperties(
          c.properties,
          {restitution:.3,friction:.05}
        );
        migrated.push(c);
        continue;
      }

      if(c.type==="PEG"||c.type==="BUMPER"){
        const bumper=c.type==="BUMPER";
        c.type="CIRCLE";
        c.properties=migratedColliderProperties(
          {
            ...c.properties,
            boost:finiteOr(
              c.properties.boost,
              bumper ? 1.15 : 0
            )
          },
          {
            restitution:bumper ? .95 : .55,
            friction:bumper ? .02 : .03
          }
        );
        migrated.push(c);
        continue;
      }

      if(c.type==="LAUNCHER"){
        const power=Math.max(0,finiteOr(c.properties.launchPower,1.2));
        const {
          launchPower,
          launchDirectionDegrees,
          launchSpreadDegrees,
          launchPowerVariance,
          ...remaining
        }=c.properties;
        c.type="WALL";
        c.properties=migratedColliderProperties(
          {
            ...remaining,
            boost:Math.max(
              0,
              finiteOr(remaining.boost,power*1.125)
            )
          },
          {restitution:.4,friction:.05}
        );
        migrated.push(c);
        continue;
      }

      if(c.type==="GEAR"){
        const {
          motorSpeed,
          motorTorque,
          linkedComponentId,
          gearRatio,
          ...remaining
        }=c.properties;
        c.type="ROTATOR";
        c.width=finiteOr(c.width,170);
        c.height=finiteOr(c.height,18);
        c.properties=migratedColliderProperties(
          {
            ...remaining,
            angularSpeed:finiteOr(motorSpeed,120),
            bladeCount:2
          },
          {restitution:.4,friction:.06}
        );
        migrated.push(c);
        continue;
      }

      if(c.type==="FUNNEL"||c.type==="SPLITTER"){
        const shapes=legacyCompoundShapes(c);
        shapes.forEach((shape,index)=>{
          const {
            gap,
            thickness,
            ...remaining
          }=(shape.properties||{});
          migrated.push({
            ...shape,
            id:String(c.id||"legacy")+"-wall-"+(index+1),
            type:"WALL",
            properties:migratedColliderProperties(
              remaining,
              {
                restitution:c.type==="FUNNEL" ? .3 : .34,
                friction:c.type==="FUNNEL" ? .06 : .05
              }
            )
          });
        });
        continue;
      }

      if(isCollider(c)){
        c.properties=migratedColliderProperties(c.properties);
      }
      migrated.push(c);
    }

    return {
      ...source,
      schemaVersion:SCHEMA_VERSION,
      components:migrated
    };
  }

  function defaultDefinition(){
    const styled = (component, visualFill, visualStroke) => ({
      ...component,
      properties:{
        ...(component.properties||{}),
        visualFill,
        visualStroke
      }
    });
    const rail = (
      x1, y1, x2, y2,
      visualFill, visualStroke,
      thickness = 20
    ) => {
      const dx = x2 - x1;
      const dy = y2 - y1;
      return styled(
        {
          ...componentDefaults(
            "WALL",
            (x1 + x2) / 2,
            (y1 + y2) / 2
          ),
          width:Math.hypot(dx,dy),
          height:thickness,
          rotation:Math.atan2(dy,dx)*180/Math.PI
        },
        visualFill,
        visualStroke
      );
    };
    const reactorPeg = (index) => {
      const angle = index / 16 * Math.PI * 2;
      return styled(
        {
          ...createPreset(
            "PEG",
            545 + Math.cos(angle) * 112,
            520 + Math.sin(angle) * 112
          ),
          radius:10,
          properties:{
            restitution:.66,
            friction:.025,
            soundMaterial:"metal",
            instrument:"click",
            audioNote:60 + (index % 5),
            audioGain:.62,
            audioPan:Math.cos(angle) * .45
          }
        },
        index % 2 ? "#f0c436" : "#6bd6ff",
        "#fff1a3"
      );
    };

    return {
      schemaVersion:SCHEMA_VERSION,
      name:"Retro Cadet Survivor V3",
      world:{width:1280,height:900,gravityX:0,gravityY:12,visualBackground:"#102758"},
      drawRule:{type:"LAST_SURVIVOR",winnerCount:1},
      runPolicy:{
        timeoutSeconds:0,
        qualificationMinWinners:1,
        qualificationMaxNudges:0
      },
      components:[
        // Start systems.
        {...componentDefaults("SPAWN",555,125),radius:28,properties:{
          marbleRadius:11,
          spawnRole:"BUNCH"
        }},
        {...componentDefaults("SPAWN",1090,735),radius:22,properties:{
          marbleRadius:11,
          spawnRole:"BURST"
        }},
        rail(1018,615,1061,765,"#1c4059","#65bfe9",12),
        rail(1162,615,1119,765,"#1c4059","#65bfe9",12),
        styled(
          {...createPreset("LAUNCH_WALL",1090,838),width:132,height:24,rotation:0,properties:{
            restitution:.5,
            friction:.025,
            boost:4.5,
            soundMaterial:"metal",instrument:"click",audioNote:60,audioGain:1,audioPan:.75
          }},
          "#335f72","#8bd8f5"
        ),

        // Closed pinball cabinet perimeter.
        // Every segment shares an exact endpoint with the next segment.
        rail(60,886,60,235,"#513821","#bd8149"),
        rail(60,235,125,123,"#5d4028","#ca9158"),
        rail(125,123,230,72,"#65452b","#d19a61"),
        rail(230,72,400,54,"#6c4a2e","#d5a066"),
        rail(400,54,595,52,"#704d30","#d8a46a"),
        rail(595,52,797,55,"#704d30","#d8a46a"),
        rail(797,55,945,65,"#704d30","#d8a46a"),

        // Shooter outer curve and right cabinet wall.
        rail(945,65,1082,75,"#704d30","#d8a46a"),
        rail(1082,75,1157,118,"#704d30","#d8a46a"),
        rail(1157,118,1188,170,"#6f4c31","#d19a5d"),
        rail(1188,170,1190,886,"#5d4028","#ca9158"),

        // Bottom cabinet closes the table completely.
        rail(1190,886,60,886,"#513821","#bd8149"),

        // Shooter inner rail: straight vertical rise, then a true open curve
        // into the upper-right playfield. It ends at x=805 instead of sealing
        // the lane across the board.
        rail(1005,835,1005,325,"#4f3724","#b77b48"),
        rail(1005,325,990,280,"#4f3724","#b77b48"),
        rail(990,280,958,238,"#513824","#bb7e4a"),
        rail(958,238,910,204,"#573c26","#c4864f"),
        rail(910,204,850,182,"#5d4028","#ca9158"),

        // Top bumper cluster.
        styled({...createPreset("BUMPER",425,225),radius:35,properties:{
          restitution:1.04,friction:.02,boost:1.38,
          soundMaterial:"metal",instrument:"bell",audioNote:67,audioGain:1.08,audioPan:-.3
        }},"#e7e3d6","#fff9d7"),
        styled({...createPreset("BUMPER",555,195),radius:37,properties:{
          restitution:1.06,friction:.02,boost:1.42,
          soundMaterial:"metal",instrument:"bell",audioNote:72,audioGain:1.12,audioPan:0
        }},"#e7e3d6","#fff9d7"),
        styled({...createPreset("BUMPER",685,230),radius:35,properties:{
          restitution:1.04,friction:.02,boost:1.38,
          soundMaterial:"metal",instrument:"bell",audioNote:76,audioGain:1.08,audioPan:.3
        }},"#e7e3d6","#fff9d7"),

        // Left purple ramp / wormhole-like lane.
        styled({...componentDefaults("WALL",205,285),width:245,height:24,rotation:55,properties:{
          restitution:.46,friction:.045,
          soundMaterial:"plastic",instrument:"none",audioNote:58,audioGain:.65,audioPan:-.7
        }},"#5d3d99","#b28cff"),
        styled({...componentDefaults("WALL",250,415),width:245,height:24,rotation:72,properties:{
          restitution:.46,friction:.045,
          soundMaterial:"plastic",instrument:"none",audioNote:58,audioGain:.65,audioPan:-.62
        }},"#6540a6","#c09bff"),
        styled({...componentDefaults("WALL",330,525),width:210,height:24,rotation:28,properties:{
          restitution:.48,friction:.045,
          soundMaterial:"plastic",instrument:"none",audioNote:60,audioGain:.65,audioPan:-.5
        }},"#6b44ab","#c6a0ff"),

        // Midfield guides.
        styled({...createPreset("PEG",340,340),radius:13,properties:{restitution:.62,friction:.03}},"#f0d450","#fff2a1"),
        styled({...createPreset("PEG",775,345),radius:13,properties:{restitution:.62,friction:.03}},"#e45d69","#ffb0b6"),
        styled({...createPreset("PEG",850,430),radius:13,properties:{restitution:.62,friction:.03}},"#f0d450","#fff2a1"),
        styled({...componentDefaults("WALL",840,305),width:205,height:18,rotation:-58},"#7b2f3f","#dc6a7b"),
        styled({...componentDefaults("WALL",845,535),width:215,height:18,rotation:53},"#7b2f3f","#dc6a7b"),

        // Central reactor ring.
        ...Array.from({length:16},(_,index)=>reactorPeg(index)),
        styled({...createPreset("BUMPER",545,520),radius:52,properties:{
          restitution:.9,friction:.02,boost:1.12,
          soundMaterial:"metal",instrument:"chime",audioNote:64,audioGain:.85,audioPan:-.05
        }},"#238eae","#72dcf5"),
        styled({...createPreset("BUMPER",545,520),radius:24,properties:{
          restitution:.82,friction:.025,boost:1.03,
          soundMaterial:"glass",instrument:"bell",audioNote:76,audioGain:.6,audioPan:-.05
        }},"#42b9d4","#b0f5ff"),

        // Lower triangular sling guides.
        styled({...componentDefaults("WALL",300,675),width:220,height:22,rotation:54,properties:{
          restitution:.76,friction:.035,
          soundMaterial:"rubber",instrument:"none",audioNote:55,audioGain:.8,audioPan:-.55
        }},"#7a3150","#e379a1"),
        styled({...componentDefaults("WALL",790,675),width:220,height:22,rotation:-54,properties:{
          restitution:.76,friction:.035,
          soundMaterial:"rubber",instrument:"none",audioNote:55,audioGain:.8,audioPan:.5
        }},"#7a3150","#e379a1"),

        // Inlane / outlane rails.
        styled({...componentDefaults("WALL",190,700),width:270,height:15,rotation:72},"#375b83","#7fb6e5"),
        styled({...componentDefaults("WALL",250,735),width:245,height:15,rotation:62},"#375b83","#7fb6e5"),
        styled({...componentDefaults("WALL",900,700),width:270,height:15,rotation:-72},"#375b83","#7fb6e5"),
        styled({...componentDefaults("WALL",840,735),width:245,height:15,rotation:-62},"#375b83","#7fb6e5"),

        // Flipper-like moving bars.
        styled({...componentDefaults("SEESAW",420,805),width:185,height:24,rotation:-18,properties:{
          restitution:.68,friction:.045,amplitude:12,period:2.3,phase:0,
          soundMaterial:"rubber",instrument:"click",audioNote:55,audioGain:.82,audioPan:-.3
        }},"#6941a9","#c49cff"),
        styled({...componentDefaults("SEESAW",670,805),width:185,height:24,rotation:18,properties:{
          restitution:.68,friction:.045,amplitude:12,period:2.3,phase:.5,
          soundMaterial:"rubber",instrument:"click",audioNote:55,audioGain:.82,audioPan:.25
        }},"#6941a9","#c49cff"),

        // Drain guides and center drain.
        styled({...componentDefaults("WALL",310,850),width:265,height:18,rotation:10},"#62432b","#c98c54"),
        styled({...componentDefaults("WALL",780,850),width:265,height:18,rotation:-10},"#62432b","#c98c54"),
        styled({...componentDefaults("ELIMINATION",545,866),width:160,height:58,properties:{
          eliminationKey:"CENTER_DRAIN",
          sensorTag:"CENTER_DRAIN",
          soundMaterial:"metal",instrument:"drum",audioNote:43,audioGain:1.12,audioPan:-.05,
          visualFill:"#05070b",
          visualStroke:"#d15378"
        }},"#05070b","#d15378")
      ]
    };
  }

  function emptyDefinition(){
    return {
      schemaVersion:SCHEMA_VERSION,
      name:"새 마블 맵",
      world:{
        width:1280,
        height:720,
        gravityX:0,
        gravityY:12,
        visualBackground:"#0a1117"
      },
      drawRule:{type:"RACE_FINISH",winnerCount:0},
      runPolicy:{
        timeoutSeconds:0,
        qualificationMinWinners:0,
        qualificationMaxNudges:0
      },
      components:[]
    };
  }

  function validateDefinition(def){
    const errors=[];
    if(!def || def.schemaVersion!==SCHEMA_VERSION) errors.push("지원하지 않는 schemaVersion입니다.");
    if(!def?.name?.trim()) errors.push("맵 이름이 필요합니다.");
    const w=Number(def?.world?.width), h=Number(def?.world?.height);
    if(!Number.isFinite(w)||!Number.isFinite(h)){
      errors.push("World 크기는 유한 숫자여야 합니다.");
    }
    const gx=Number(def?.world?.gravityX), gy=Number(def?.world?.gravityY);
    if(!Number.isFinite(gx)||!Number.isFinite(gy)){
      errors.push("중력 값은 유한 숫자여야 합니다.");
    }
    const comps=Array.isArray(def?.components)?def.components:[];
    const rule=resolvedDrawRule(def);
    if(![
      "RACE_FINISH",
      "ORDERED_OUTPUT",
      "SLOT_COLLECTION",
      "LAST_SURVIVOR",
      "CASCADE_SELECTION",
      "RANDOM_OUTPUT_BUCKET",
      "CONDITIONAL_OUTPUT"
    ].includes(rule.type)){
      errors.push("지원하지 않는 drawRule type입니다.");
    }
    const runPolicy=resolvedRunPolicy(def);
    const rawTimeout=finiteOr(def?.runPolicy?.timeoutSeconds,0);
    const rawMinWinners=Math.trunc(finiteOr(def?.runPolicy?.qualificationMinWinners,0));
    const rawMaxNudges=Math.trunc(finiteOr(def?.runPolicy?.qualificationMaxNudges,0));
    const ids=new Set();
    const typeById=new Map();
    const outputKeys=new Set();
    const outputRanks=new Set();
    const slotKeys=new Set();
    const eliminationKeys=new Set();
    const sensorTags=new Set();
    const branchProducerKeys=new Set();
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
      }
      if(["WALL","CURVE_WALL","FINISH","GATE","ROTATOR","PENDULUM","SEESAW","HINGE","PADDLE","CONVEYOR","ELEVATOR","OUTPUT","SLOT","ELIMINATION"].includes(c?.type)){
        const cw=Number(c?.width),ch=Number(c?.height);
        if(!Number.isFinite(cw)||!Number.isFinite(ch)){
          errors.push("사각형/복합 컴포넌트 크기는 유한 숫자여야 합니다.");
        }
      }
      if(["CIRCLE","SPAWN","BURST_SPAWN"].includes(c?.type)){
        const radius=Number(c?.radius);
        if(!Number.isFinite(radius)){
          errors.push("원형 컴포넌트 radius는 유한 숫자여야 합니다.");
        }
      }
      const p=c?.properties||{};
      if(isCollider(c)){
        const boost=finiteOr(p.boost,0);
        if(!Number.isFinite(boost)){
          errors.push("Collider boost는 유한 숫자여야 합니다.");
        }
      }
      if(c?.type==="ROTATOR"){
        const bladeCount=Number(p.bladeCount ?? 1);
        if(
          !Number.isInteger(bladeCount)
          || bladeCount<1
          || bladeCount>4
        ){
          errors.push("회전판 수는 1~4 정수여야 합니다.");
        }
      }
      if(["FINISH","OUTPUT","SLOT","ELIMINATION"].includes(c?.type)){
        const sensorTag=String(p.sensorTag||"").trim();
        if(sensorTag) sensorTags.add(sensorTag);
      }
      if(c?.type==="OUTPUT"){
        const key=String(p.outputKey||"").trim();
        const rank=Math.trunc(finiteOr(p.outputRank,0));
        const capacity=Math.trunc(finiteOr(p.outputCapacity,1));
        const weight=finiteOr(p.outputWeight,1);
        const priority=Math.trunc(finiteOr(p.outputPriority,0));
        const conditionType=String(p.conditionType||"ALWAYS").toUpperCase();
        const conditionClaims=Math.trunc(finiteOr(p.conditionClaims,1));
        const conditionSeconds=finiteOr(p.conditionSeconds,1);
        const branchSetKey=String(p.branchSetKey||"").trim();
        const branchSetValue=String(p.branchSetValue||"ON").trim();
        if(!key) errors.push("Output outputKey가 필요합니다.");
        if(outputKeys.has(key)) errors.push("Output outputKey는 고유해야 합니다.");
        outputKeys.add(key);
        if(rule.type==="ORDERED_OUTPUT"&&outputRanks.has(rank)) errors.push("ORDERED_OUTPUT outputRank는 고유해야 합니다.");
        outputRanks.add(rank);
        if(![
          "ALWAYS",
          "AFTER_ANY_CLAIM",
          "AFTER_OUTPUT_CLAIMS",
          "AFTER_OUTPUT_FULL",
          "AFTER_SECONDS",
          "AFTER_SENSOR_CLAIMS",
          "AFTER_BRANCH_STATE"
        ].includes(conditionType)){
          errors.push("Output conditionType이 유효하지 않습니다.");
        }
        if(branchSetKey) branchProducerKeys.add(
          branchSetKey+"\u0000"+branchSetValue
        );
        totalOutputCapacity+=Math.max(0,capacity);
        output++;
      }
      if(c?.type==="SLOT"){
        const key=String(p.slotKey||"").trim();
        const capacity=Math.trunc(finiteOr(p.slotCapacity,1));
        if(!key) errors.push("Slot slotKey가 필요합니다.");
        if(slotKeys.has(key)) errors.push("Slot slotKey는 고유해야 합니다.");
        slotKeys.add(key);
        totalSlotCapacity+=Math.max(0,capacity);
        slot++;
      }
      if(c?.type==="ELIMINATION"){
        const key=String(p.eliminationKey||"").trim();
        if(!key) errors.push("Elimination eliminationKey가 필요합니다.");
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

      if(c?.type==="SPAWN"||c?.type==="BURST_SPAWN") spawn++;
      if(c?.type==="FINISH") finish++;
    }

    const outputs=comps.filter(c=>c?.type==="OUTPUT");
    const outputByKey=new Map(outputs.map(c=>[
      String(c.properties?.outputKey||""),
      c
    ]));
    for(const c of outputs){
      const p=c.properties||{};
      const mode=String(p.conditionType||"ALWAYS").toUpperCase();
      const targetKey=String(p.conditionOutputKey||"").trim();
      if(["AFTER_OUTPUT_CLAIMS","AFTER_OUTPUT_FULL"].includes(mode)){
        if(!targetKey||!outputByKey.has(targetKey)){
          errors.push("Conditional Output 참조 대상이 존재하지 않습니다.");
        }else if(targetKey===String(p.outputKey||"")){
          errors.push("Conditional Output은 자기 자신을 참조할 수 없습니다.");
        }else if(mode==="AFTER_OUTPUT_CLAIMS"){
          const target=outputByKey.get(targetKey);
          const threshold=Math.trunc(finiteOr(p.conditionClaims,1));
          const capacity=Math.trunc(finiteOr(target?.properties?.outputCapacity,1));
          if(threshold>capacity){
            errors.push("conditionClaims는 참조 Output capacity를 초과할 수 없습니다.");
          }
        }
      }
      if(mode==="AFTER_SENSOR_CLAIMS"){
        const tag=String(p.conditionSensorTag||"").trim();
        if(!tag||!sensorTags.has(tag)){
          errors.push("Conditional Output sensor tag 대상이 존재하지 않습니다.");
        }
      }
      if(mode==="AFTER_BRANCH_STATE"){
        const key=String(p.conditionBranchKey||"").trim();
        const value=String(p.conditionBranchValue||"ON").trim();
        if(!key||!branchProducerKeys.has(key+"\u0000"+value)){
          errors.push("Conditional Output branch state producer가 존재하지 않습니다.");
        }
      }
    }

    if(rule.type==="CONDITIONAL_OUTPUT"){
      if(!outputs.length){
        errors.push("CONDITIONAL_OUTPUT에는 OUTPUT이 최소 1개 필요합니다.");
      }
      const dependencies=(c)=>{
        const p=c?.properties||{};
        const mode=String(p.conditionType||"ALWAYS").toUpperCase();
        if(["AFTER_OUTPUT_CLAIMS","AFTER_OUTPUT_FULL"].includes(mode)){
          const key=String(p.conditionOutputKey||"").trim();
          return key&&outputByKey.has(key)?[key]:[];
        }
        if(mode==="AFTER_SENSOR_CLAIMS"){
          const tag=String(p.conditionSensorTag||"").trim();
          const external=(def.components||[]).some(sensor=>
            sensor.type!=="OUTPUT"
            && ["FINISH","SLOT","ELIMINATION"].includes(sensor.type)
            && String(sensor.properties?.sensorTag||"").trim()===tag
          );
          if(external) return [];
          const producers=outputs
            .filter(o=>String(o.properties?.sensorTag||"").trim()===tag)
            .map(o=>String(o.properties?.outputKey||""));
          return producers.length===1 ? producers : [];
        }
        if(mode==="AFTER_BRANCH_STATE"){
          const key=String(p.conditionBranchKey||"").trim();
          const value=String(p.conditionBranchValue||"ON").trim();
          const producers=outputs
            .filter(o=>
              String(o.properties?.branchSetKey||"").trim()===key
              && String(o.properties?.branchSetValue||"ON").trim()===value
            )
            .map(o=>String(o.properties?.outputKey||""));
          return producers.length===1 ? producers : [];
        }
        return [];
      };
      const starter=outputs.some(c=>{
        const p=c.properties||{};
        const mode=String(p.conditionType||"ALWAYS").toUpperCase();
        if(["ALWAYS","AFTER_SECONDS"].includes(mode)) return true;
        if(mode==="AFTER_SENSOR_CLAIMS"){
          const tag=String(p.conditionSensorTag||"").trim();
          return comps.some(sensor=>
            sensor.type!=="OUTPUT"
            && ["FINISH","SLOT","ELIMINATION"].includes(sensor.type)
            && String(sensor.properties?.sensorTag||"").trim()===tag
          );
        }
        return false;
      });
      if(outputs.length&&!starter){
        errors.push("CONDITIONAL_OUTPUT에는 독립적으로 활성화 가능한 root 조건이 필요합니다.");
      }
      const visiting=new Set(),visited=new Set();
      const hasCycle=(key)=>{
        if(visiting.has(key)) return true;
        if(visited.has(key)) return false;
        visiting.add(key);
        const c=outputByKey.get(key);
        for(const next of dependencies(c)){
          if(next&&outputByKey.has(next)&&hasCycle(next)) return true;
        }
        visiting.delete(key);
        visited.add(key);
        return false;
      };
      if(outputs.some(c=>hasCycle(String(c.properties?.outputKey||"")))){
        errors.push("Conditional Output dependency에 순환 참조가 있습니다.");
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
    if(rule.type==="CONDITIONAL_OUTPUT"){
      const winners=rule.winnerCount||totalOutputCapacity;
      if(winners<1||winners>totalOutputCapacity){
        errors.push("CONDITIONAL_OUTPUT winnerCount가 Output 총 capacity를 초과할 수 없습니다.");
      }
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
      const migrated=migrateDefinition(definition);
      const errors=validateDefinition(migrated);
      if(errors.length) throw new Error(errors.join(" "));
      this.definition=structuredClone(migrated);
      this.marbles=[];
      this.finishOrder=[];
      this.outputClaims=new Map();
      this.slotClaims=new Map();
      this.sensorClaims=new Map();
      this.branchStates=new Map();
      this.eliminationOrder=[];
      this.dnfOrder=[];
      this.timedOut=false;
      this.selectedOutputKey=null;
      this.accumulator=0;
      this.time=0;
    }

    reset(count=12,seed=this.seed){
      const rng=seeded(seed);
      this.random=rng;
      const spawns=this.definition.components.filter(
        c=>c.type==="SPAWN"||c.type==="BURST_SPAWN"
      );
      const n=Math.max(1,Math.floor(Number(count)||1));
      this.marbles=[];
      this.finishOrder=[];
      this.outputClaims=new Map();
      this.slotClaims=new Map();
      this.sensorClaims=new Map();
      this.branchStates=new Map();
      this.eliminationOrder=[];
      this.dnfOrder=[];
      this.timedOut=false;
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
        const localIndex=Math.floor(i/spawns.length);
        const angle=(localIndex*2.399963229728653)+(rng()-.5)*.2;
        const spread=Math.sqrt(localIndex+1)*Math.min(r*1.35,16);
        let vx=(rng()-.5)*35;
        let vy=(rng()-.5)*8;
        if(spawn.type==="BURST_SPAWN"){
          const jitter=(rng()*2-1)*clamp(finiteOr(spawn.properties?.burstSpreadDegrees,24),0,90);
          const direction=degToRad(finiteOr(spawn.properties?.burstDirectionDegrees,-90)+jitter);
          const variance=clamp(finiteOr(spawn.properties?.burstPowerVariance,.22),0,.75);
          const power=Math.max(0,finiteOr(spawn.properties?.burstPower,1.15))
            *(1+(rng()*2-1)*variance);
          vx=Math.cos(direction)*power*145;
          vy=Math.sin(direction)*power*145;
        }
        this.marbles.push({
          id:"m"+(i+1),
          x:spawn.x+Math.cos(angle)*spread,
          y:spawn.y+Math.sin(angle)*spread,
          vx,
          vy,
          radius:r,
          finished:false,
          eliminated:false,
          dnf:false,
          rank:0,
          finishTime:null,
          boostContacts:new Set()
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
        if(m.finished||m.eliminated||m.dnf) continue;
        m.vx+=world.gravityX*gravityScale*dt;
        m.vy+=world.gravityY*gravityScale*dt;
        m.vx*=0.9995;
        m.vy*=0.9995;
        m.x+=m.vx*dt;
        m.y+=m.vy*dt;

        this.resolveWorldBounds(m,world);
        const nextBoostContacts=new Set();
        for(const c of this.definition.components){
          for(const shape of componentShapes(c,this.time)){
            if(isRectCollider(c)){
              this.resolveRect(m,shape,nextBoostContacts);
            }else if(c.type==="CIRCLE"){
              this.resolveCircle(m,shape,nextBoostContacts);
            }
          }
        }
        m.boostContacts=nextBoostContacts;
      }

      this.resolveMarblePairs();
      this.applyConveyors(dt);

      this.detectTaggedSensors();
      this.detectResultSensors();
      this.applyTimeout();
    }

    detectTaggedSensors(){
      const sensors=this.definition.components.filter(c=>
        ["FINISH","OUTPUT","SLOT","ELIMINATION"].includes(c.type)
        && String(c.properties?.sensorTag||"").trim()
      );
      if(!sensors.length) return;
      for(const m of this.marbles){
        if(m.finished||m.eliminated||m.dnf) continue;
        for(const sensor of sensors){
          if(!this.pointInRect(m.x,m.y,sensor)) continue;
          const tag=String(sensor.properties?.sensorTag||"").trim();
          const claims=this.sensorClaims.get(tag)||new Set();
          claims.add(m.id);
          this.sensorClaims.set(tag,claims);
        }
      }
    }

    applyOutputBranch(output){
      const key=String(output?.properties?.branchSetKey||"").trim();
      if(!key) return;
      this.branchStates.set(
        key,
        String(output.properties?.branchSetValue||"ON").trim()
      );
    }

    applyTimeout(){
      if(this.timedOut) return;
      const policy=resolvedRunPolicy(this.definition);
      if(policy.timeoutSeconds<=0||this.time<policy.timeoutSeconds) return;
      const target=targetCountForDefinition(this.definition);
      if(this.finishOrder.length>=target) return;
      this.timedOut=true;
      for(const m of this.marbles){
        if(m.finished||m.eliminated||m.dnf) continue;
        m.dnf=true;
        m.vx=0;m.vy=0;
        this.dnfOrder.push(m.id);
      }
    }

    completeMarble(m,rank){
      m.finished=true;
      m.rank=rank;
      m.finishTime=this.time;
      m.vx=0;m.vy=0;
    }

    detectResultSensors(){
      const rule=resolvedDrawRule(this.definition);
      const active=this.marbles.filter(m=>!m.finished&&!m.eliminated&&!m.dnf);

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
        const survivors=this.marbles.filter(m=>!m.finished&&!m.eliminated&&!m.dnf);
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

      if(rule.type==="CONDITIONAL_OUTPUT"){
        const outputs=this.definition.components.filter(c=>c.type==="OUTPUT");
        const target=rule.winnerCount||outputs.reduce((sum,c)=>sum+Math.trunc(finiteOr(c.properties?.outputCapacity,1)),0);
        for(const m of active){
          if(this.finishOrder.length>=target) break;
          const candidates=outputs
            .filter(candidate=>{
              const key=String(candidate.properties?.outputKey||candidate.id);
              const claims=this.outputClaims.get(key)||[];
              return Array.isArray(claims)
                && claims.length<Math.trunc(finiteOr(candidate.properties?.outputCapacity,1))
                && conditionalOutputActive(
                  candidate,
                  this.definition,
                  {
                    outputClaims:this.outputClaims,
                    sensorClaims:this.sensorClaims,
                    branchStates:this.branchStates,
                    time:this.time
                  }
                )
                && this.pointInRect(m.x,m.y,candidate);
            })
            .sort((a,b)=>{
              const pa=Math.trunc(finiteOr(a.properties?.outputPriority,0));
              const pb=Math.trunc(finiteOr(b.properties?.outputPriority,0));
              if(pa!==pb) return pb-pa;
              return Math.trunc(finiteOr(a.properties?.outputRank,1))
                - Math.trunc(finiteOr(b.properties?.outputRank,1));
            });
          const output=candidates[0];
          if(!output) continue;
          const key=String(output.properties?.outputKey||output.id);
          const claims=this.outputClaims.get(key)||[];
          claims.push(m.id);
          this.outputClaims.set(key,claims);
          this.applyOutputBranch(output);
          this.finishOrder.push(m.id);
          this.completeMarble(m,this.finishOrder.length);
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

    resolveRect(m,c,nextBoostContacts=null){
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
      const boost=Math.max(0,finiteOr(c.properties?.boost,0));
      if(boost>0&&nextBoostContacts){
        nextBoostContacts.add(c.id);
        if(!m.boostContacts?.has(c.id)){
          m.vx+=wx*boost*70;
          m.vy+=wy*boost*70;
        }
      }
    }

    resolveCircle(m,c,nextBoostContacts=null){
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
          finiteOr(c.properties?.restitution,.55),
          0,
          1.4
        );
        m.vx-=(1+restitution)*vn*nx;
        m.vy-=(1+restitution)*vn*ny;
      }
      const boost=Math.max(0,finiteOr(c.properties?.boost,0));
      if(boost>0&&nextBoostContacts){
        nextBoostContacts.add(c.id);
        if(!m.boostContacts?.has(c.id)){
          m.vx+=nx*boost*70;
          m.vy+=ny*boost*70;
        }
      }
    }

    applyConveyors(dt){
      const conveyors=this.definition.components.filter(c=>c.type==="CONVEYOR");
      if(!conveyors.length) return;
      for(const m of this.marbles){
        if(m.finished||m.eliminated||m.dnf) continue;
        for(const conveyor of conveyors){
          const local=this.localPoint(m.x,m.y,conveyor);
          const halfW=Math.max(1,conveyor.width/2);
          const halfH=Math.max(1,conveyor.height/2);
          if(
            Math.abs(local.x)>halfW+m.radius
            || Math.abs(Math.abs(local.y)-halfH)>m.radius+5
          ) continue;
          const a=degToRad(conveyor.rotation||0);
          const tx=Math.cos(a),ty=Math.sin(a);
          const target=clamp(finiteOr(conveyor.properties?.beltSpeed,160),-1200,1200);
          const grip=clamp(finiteOr(conveyor.properties?.beltGrip,.22),0,1);
          const current=m.vx*tx+m.vy*ty;
          const maxChange=Math.max(20,Math.abs(target)*3)*dt;
          const change=clamp((target-current)*grip,-maxChange,maxChange);
          m.vx+=tx*change;
          m.vy+=ty*change;
        }
      }
    }

    localPoint(x,y,c){
      const a=-degToRad(c.rotation||0),co=Math.cos(a),si=Math.sin(a);
      const dx=x-c.x,dy=y-c.y;
      return {x:dx*co-dy*si,y:dx*si+dy*co};
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
        const a=ms[i]; if(a.finished||a.eliminated||a.dnf) continue;
        for(let j=i+1;j<ms.length;j++){
          const b=ms[j]; if(b.finished||b.eliminated||b.dnf) continue;
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
      if(!marble||marble.finished||marble.eliminated||marble.dnf) return false;
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
          finished:m.finished,eliminated:m.eliminated,dnf:m.dnf,rank:m.rank,finishTime:m.finishTime
        })),
        finishOrder:[...this.finishOrder],
        winnerOrder:[...this.finishOrder],
        outputClaims:[...this.outputClaims.entries()].map(([key,value])=>({key,value})),
        slotClaims:[...this.slotClaims.entries()].map(([key,ids])=>({key,ids:[...ids]})),
        sensorClaims:[...this.sensorClaims.entries()].map(([tag,ids])=>({tag,ids:[...ids]})),
        branchStates:[...this.branchStates.entries()].map(([key,value])=>({key,value})),
        eliminationOrder:[...this.eliminationOrder],
        dnfOrder:[...this.dnfOrder],
        timedOut:this.timedOut,
        runStatus:this.timedOut
          ? "TIMEOUT"
          : this.finishOrder.length>=targetCountForDefinition(this.definition)
            ? "COMPLETED"
            : "RUNNING",
        selectedOutputKey:this.selectedOutputKey,
        finishedCount:this.finishOrder.length,
        targetCount:Number.isFinite(targetCountForDefinition(this.definition))
          ? targetCountForDefinition(this.definition)
          : this.marbles.length,
        totalCount:this.marbles.length
      };
    }
  }

  root.ViewerDrawMapEngine={
    LEGACY_SCHEMA_VERSION,
    SCHEMA_VERSION,
    componentDefaults,
    createPreset,
    migrateDefinition,
    isCollider,
    isRectCollider,
    defaultDefinition,
    emptyDefinition,
    validateDefinition,
    componentShapes,
    motionRotation,
    resolvedDrawRule,
    resolvedRunPolicy,
    targetCountForDefinition,
    conditionalOutputActive,
    elevatorPosition,
    PreviewEngine
  };
})(globalThis);
