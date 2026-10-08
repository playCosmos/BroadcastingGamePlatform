((root) => {
  "use strict";

  const LEGACY_SCHEMA_VERSION = "viewer-draw-machine-map/v0";
  const SCHEMA_VERSION = "viewer-draw-machine-map/v1";
  const TYPES = new Set([
    "WALL","CURVE_WALL","CIRCLE",
    "SPAWN","BURST_SPAWN","FINISH",
    "ROTATIONAL_BODY",
    "CONVEYOR","ELEVATOR",
    "OUTPUT","SLOT","ELIMINATION"
  ]);
  const RECT_COLLIDER_TYPES = new Set([
    "WALL","ROTATIONAL_BODY","CONVEYOR","ELEVATOR"
  ]);
  const DIRECTIONAL_COLLIDER_TYPES = new Set(
    RECT_COLLIDER_TYPES
  );
  const COLLIDER_TYPES = new Set([
    ...RECT_COLLIDER_TYPES,
    "CURVE_WALL",
    "CIRCLE"
  ]);

  const DEFAULT_VISUAL_STYLE = Object.freeze({
    WALL:["#6f7c87","#a6b0b8"],
    CURVE_WALL:["#566d7a","#a8d4e8"],
    CIRCLE:["#d0d6db","#f5f7f8"],
    ROTATIONAL_BODY:["#875b2f","#f0b36a"],
    CONVEYOR:["#47565f","#8fc6df"],
    ELEVATOR:["#3f586d","#84a8c6"],
    OUTPUT:["#3f744c","#8bd3a1"],
    SLOT:["#73503e","#dda57e"],
    ELIMINATION:["#713d50","#df789d"],
    SPAWN:["#216e8f","#62c3e7"],
    BURST_SPAWN:["#784878","#e092df"],
    FINISH:["#367c4d","#74d191"]
  });

  function defaultVisualStyle(type){
    const pair=DEFAULT_VISUAL_STYLE[type]||["#59636c","#aab2b8"];
    return {fill:pair[0],stroke:pair[1]};
  }

  function componentVisualStyle(component){
    const defaults=defaultVisualStyle(component?.type);
    return {
      fill:String(component?.properties?.visualFill||defaults.fill),
      stroke:String(component?.properties?.visualStroke||defaults.stroke)
    };
  }

  const clamp = (v,min,max) => Math.max(min,Math.min(max,v));
  const degToRad = (deg) => deg * Math.PI / 180;
  const finiteOr = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const colliderProperties = (
    overrides = {},
    defaults = {restitution:.35, friction:.05}
  ) => {
    const rawMode = String(
      overrides.collisionMode
      ?? defaults.collisionMode
      ?? "SOLID"
    ).toUpperCase();
    const direction = finiteOr(
      overrides.oneWayDirection,
      finiteOr(defaults.oneWayDirection,1)
    ) < 0 ? -1 : 1;
    return {
      collisionMode:rawMode==="ONE_WAY" ? "ONE_WAY" : "SOLID",
      oneWayDirection:direction,
      restitution:finiteOr(
        overrides.restitution,
        finiteOr(defaults.restitution,.35)
      ),
      friction:finiteOr(
        overrides.friction,
        finiteOr(defaults.friction,.05)
      ),
      boost:finiteOr(overrides.boost,0),
      ...overrides,
      collisionMode:rawMode==="ONE_WAY" ? "ONE_WAY" : "SOLID",
      oneWayDirection:direction
    };
  };
  const isCollider = (component) =>
    Boolean(component && COLLIDER_TYPES.has(component.type));
  const isRectCollider = (component) =>
    Boolean(component && (
      RECT_COLLIDER_TYPES.has(component.type)
      || component.type === "CURVE_WALL"
    ));
  const isDirectionalCollider = (component) =>
    Boolean(
      component
      && DIRECTIONAL_COLLIDER_TYPES.has(component.type)
    );
  const colliderCollisionMode = (component) =>
    isDirectionalCollider(component)
      ? String(
          component.properties?.collisionMode || "SOLID"
        ).toUpperCase()
      : "SOLID";
  const oneWayDirection = (component) =>
    finiteOr(component?.properties?.oneWayDirection, 1) < 0 ? -1 : 1;
  const isOneWayCollider = (component) =>
    isDirectionalCollider(component)
    && colliderCollisionMode(component) === "ONE_WAY";
  const wallCollisionMode = colliderCollisionMode;
  const isOneWayWall = (component) =>
    component?.type === "WALL"
    && isOneWayCollider(component);

  function resolvedDrawRule(def){
    const raw=def?.drawRule||{};
    const type=String(raw.type||"RACE_FINISH").toUpperCase();
    const winnerCount=Math.trunc(finiteOr(raw.winnerCount,0));
    return {type,winnerCount};
  }

  function resolvedRunPolicy(def){
    const raw=def?.runPolicy||{};
    return {
      timeoutSeconds:finiteOr(raw.timeoutSeconds,0),
      qualificationMinWinners:Math.trunc(
        finiteOr(raw.qualificationMinWinners,0)
      ),
      qualificationMaxNudges:Math.trunc(
        finiteOr(raw.qualificationMaxNudges,0)
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
    const threshold=Math.trunc(finiteOr(p.conditionClaims,1));
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
      return time>=finiteOr(p.conditionSeconds,1);
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
    const min=finiteOr(p.travelMin,-120);
    const max=finiteOr(p.travelMax,120);
    const lower=Math.min(min,max),upper=Math.max(min,max);
    const span=upper-lower;
    const speed=Math.abs(finiteOr(p.motorSpeed,90));
    const t=Math.max(0,finiteOr(time,0));
    if(span===0){
      const axis=degToRad(finiteOr(p.axisAngle,-90));
      return {
        x:c.x+Math.cos(axis)*lower,
        y:c.y+Math.sin(axis)*lower
      };
    }
    const start=Math.max(lower,Math.min(upper,0));
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

  function circularArcGeometry(c){
    const w=Math.max(.001,Math.abs(finiteOr(c?.width,260)));
    const h=Math.max(.001,Math.abs(finiteOr(c?.height,120)));
    const radius=(w*w)/(8*h)+h/2;
    const centerY=radius-h/2;
    const endpointDy=h-radius;
    const startAngle=(
      Math.atan2(endpointDy,-w/2)*180/Math.PI+360
    )%360;
    const endAngle=(
      Math.atan2(endpointDy,w/2)*180/Math.PI+360
    )%360;
    return {radius,centerY,startAngle,endAngle};
  }

  function circularArcSweep(startAngle,endAngle){
    const start=clamp(finiteOr(startAngle,0),0,360);
    const end=clamp(finiteOr(endAngle,360),0,360);
    const raw=end-start;
    if(Math.abs(raw)>=359.999 || Math.abs(raw)<1e-9) return 360;
    return ((raw%360)+360)%360;
  }

  const ROTATION_MODES = new Set([
    "FORCE_CONTINUOUS",
    "FORCE_OSCILLATE",
    "TORQUE_CONTINUOUS",
    "TORQUE_OSCILLATE",
    "FREE"
  ]);

  function rotationMode(component){
    const mode=String(
      component?.properties?.rotationMode||"FORCE_CONTINUOUS"
    ).toUpperCase();
    return ROTATION_MODES.has(mode)
      ? mode
      : "FORCE_CONTINUOUS";
  }

  function rotationLimitRange(component){
    const p=component?.properties||{};
    const base=finiteOr(component?.rotation,0);
    const start=finiteOr(p.startAngle,-70);
    const end=finiteOr(p.endAngle,70);
    return {
      min:base+Math.min(start,end),
      max:base+Math.max(start,end)
    };
  }

  function rotationInitialAngle(component){
    const base=finiteOr(component?.rotation,0);
    if(rotationMode(component)!=="FREE") return base;
    return base+finiteOr(component?.properties?.startAngle,-70);
  }

  function componentPivotLocal(c){
    const ratio=finiteOr(c?.properties?.pivotRatio,0);
    const width=finiteOr(c?.width,0);
    const height=finiteOr(c?.height,0);
    if(Math.abs(height)>Math.abs(width)){
      return {x:0,y:height*ratio};
    }
    return {x:width*ratio,y:0};
  }

  function componentPivotWorld(c){
    const local=componentPivotLocal(c);
    const liveRotation=Number(c?.runtimeRotation);
    const angle=degToRad(
      Number.isFinite(liveRotation)
        ? liveRotation
        : finiteOr(c?.rotation,0)
    );
    const co=Math.cos(angle),si=Math.sin(angle);
    return {
      x:finiteOr(c?.x,0)+local.x*co-local.y*si,
      y:finiteOr(c?.y,0)+local.x*si+local.y*co
    };
  }

  function pivotedComponentShape(c,rotation){
    const local=componentPivotLocal(c);
    if(Math.abs(local.x)<1e-9&&Math.abs(local.y)<1e-9){
      return {...c,rotation};
    }
    const pivot=componentPivotWorld(c);
    const angle=degToRad(rotation);
    const co=Math.cos(angle),si=Math.sin(angle);
    return {
      ...c,
      x:pivot.x-(local.x*co-local.y*si),
      y:pivot.y-(local.x*si+local.y*co),
      rotation
    };
  }

  function motionRotation(c,time=0){
    const runtimeRotation=Number(c?.runtimeRotation);
    if(Number.isFinite(runtimeRotation)) return runtimeRotation;
    const base=finiteOr(c?.rotation,0);
    if(c?.type!=="ROTATIONAL_BODY") return base;

    const p=c?.properties||{};
    const mode=rotationMode(c);
    const t=Math.max(0,finiteOr(time,0));

    if(mode==="FORCE_CONTINUOUS"){
      return base+finiteOr(p.angularSpeed,90)*t;
    }
    if(mode==="FORCE_OSCILLATE"){
      const startAngle=finiteOr(p.startAngle,-30);
      const endAngle=finiteOr(p.endAngle,30);
      const period=Math.max(0,finiteOr(p.period,3.2));
      if(period===0){
        return base+(startAngle+endAngle)/2;
      }
      const phase=finiteOr(p.phase,0)*Math.PI*2;
      const wave=.5+.5*Math.sin((Math.PI*2*t/period)+phase);
      return base+startAngle+(endAngle-startAngle)*wave;
    }
    return base;
  }

  function componentShapes(c,time=0){
    if(c?.type==="ROTATIONAL_BODY"){
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
        (_,index)=>pivotedComponentShape(
          c,
          rotation+(180/bladeCount)*index
        )
      );
    }
    if(c?.type==="ELEVATOR"){
      const position=elevatorPosition(c,time);
      return [{...c,...position}];
    }

    const p=c.properties||{};
    if(c.type==="CURVE_WALL"){
      const w=Math.max(.001,Math.abs(finiteOr(c.width,260)));
      const h=Math.max(.001,Math.abs(finiteOr(c.height,120)));
      const thickness=Math.max(.001,Math.abs(finiteOr(p.thickness,18)));
      const segments=clamp(Math.trunc(finiteOr(p.segments,16)),6,32);
      const curveMode=String(p.curveMode||"PARABOLA").toUpperCase();
      const points=[];

      if(curveMode==="CIRCULAR_ARC"){
        // Width/height continue to determine the source circle exactly
        // as before; arcStartAngle/arcEndAngle trim any 0..360° portion.
        const geometry=circularArcGeometry(c);
        const startAngle=clamp(
          finiteOr(p.arcStartAngle,geometry.startAngle),
          0,
          360
        );
        const endAngle=clamp(
          finiteOr(p.arcEndAngle,geometry.endAngle),
          0,
          360
        );
        const sweep=circularArcSweep(startAngle,endAngle);

        for(let i=0;i<=segments;i++){
          const t=i/segments;
          const angle=degToRad(startAngle+sweep*t);
          points.push({
            x:Math.cos(angle)*geometry.radius,
            y:geometry.centerY+Math.sin(angle)*geometry.radius
          });
        }
      }else{
        const rawStart=clamp(
          finiteOr(p.curveStartPercent,0),
          0,
          100
        )/100;
        const rawEnd=clamp(
          finiteOr(p.curveEndPercent,100),
          0,
          100
        )/100;
        const start=Math.min(rawStart,rawEnd);
        const end=Math.max(rawStart,rawEnd);
        const span=Math.max(0,end-start);
        const activeSegments=Math.max(
          1,
          Math.ceil(segments*span)
        );
        for(let i=0;i<=activeSegments;i++){
          const t=start+span*(i/activeSegments);
          const omt=1-t;
          const x=omt*omt*(-w/2)+2*omt*t*0+t*t*(w/2);
          const y=omt*omt*(h/2)+2*omt*t*(-h/2)+t*t*(h/2);
          points.push({x,y});
        }
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
        properties:colliderProperties(
          {},
          {restitution:.35,friction:.02}
        )
      };
      case "CURVE_WALL": return {
        ...base,
        width:280,
        height:140,
        properties:colliderProperties(
          {
            curveMode:"PARABOLA",
            curveStartPercent:0,
            curveEndPercent:100,
            thickness:18,
            segments:16
          },
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
      case "ROTATIONAL_BODY": return {
        ...base,
        width:190,
        height:16,
        properties:colliderProperties(
          {
            rotationPreset:"ROTATOR",
            rotationMode:"FORCE_CONTINUOUS",
            pivotRatio:0,
            angularSpeed:90,
            startAngle:-30,
            endAngle:30,
            period:3.2,
            phase:0,
            motorTorque:30,
            jointFriction:.15,
            bladeCount:1
          },
          {restitution:.42,friction:.04}
        )
      };
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
      case "ELIMINATION": return {
        ...base,
        type:"FINISH",
        width:260,
        height:56,
        properties:{sensorTag:""}
      };
      default: throw new Error("Unsupported component type: "+type);
    }
  }

  function createPreset(name,x=640,y=360){
    const preset=String(name||"").toUpperCase();
    if(preset==="WALL") return componentDefaults("WALL",x,y);
    if(preset==="ONE_WAY_WALL"||preset==="MAGIC_MIRROR"){
      const c=componentDefaults("WALL",x,y);
      c.width=220;
      c.height=18;
      c.properties=colliderProperties(
        {
          ...c.properties,
          collisionMode:"ONE_WAY",
          oneWayDirection:1,
          visualFill:"#326579",
          visualStroke:"#8de4ff"
        },
        {restitution:.35,friction:.06}
      );
      return c;
    }
    if(preset==="CURVE_PARABOLA"||preset==="PARABOLA"){
      const c=componentDefaults("CURVE_WALL",x,y);
      c.properties=colliderProperties(
        {
          ...c.properties,
          curveMode:"PARABOLA",
          visualFill:"#566d7a",
          visualStroke:"#a8d4e8"
        },
        {restitution:.35,friction:.06}
      );
      return c;
    }
    if(preset==="CIRCULAR_ARC"||preset==="ARC"){
      const c=componentDefaults("CURVE_WALL",x,y);
      c.width=280;
      c.height=140;
      const geometry=circularArcGeometry(c);
      c.properties=colliderProperties(
        {
          ...c.properties,
          curveMode:"CIRCULAR_ARC",
          arcStartAngle:geometry.startAngle,
          arcEndAngle:geometry.endAngle,
          segments:24,
          visualFill:"#3f6676",
          visualStroke:"#78c9e8"
        },
        {restitution:.35,friction:.06}
      );
      return c;
    }
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

    const rotationPresets={
      ROTATOR:{
        width:190,height:16,
        restitution:.42,friction:.04,
        visualFill:"#875b2f",visualStroke:"#f0b36a",
        props:{
          rotationMode:"FORCE_CONTINUOUS",
          pivotRatio:0,angularSpeed:90,
          startAngle:-30,endAngle:30,period:3.2,
          motorTorque:30,jointFriction:.15,bladeCount:1
        }
      },
      GATE:{
        width:180,height:16,
        restitution:.35,friction:.05,
        visualFill:"#6d4e9a",visualStroke:"#b995ee",
        props:{
          rotationMode:"FORCE_OSCILLATE",
          pivotRatio:-.5,angularSpeed:90,
          startAngle:0,endAngle:78,period:3.6,
          motorTorque:30,jointFriction:.15,bladeCount:1
        }
      },
      PENDULUM:{
        width:18,height:190,
        restitution:.4,friction:.05,
        visualFill:"#496b8f",visualStroke:"#82b6e9",
        props:{
          rotationMode:"FORCE_OSCILLATE",
          pivotRatio:-.5,angularSpeed:90,
          startAngle:-42,endAngle:42,period:3.2,
          motorTorque:30,jointFriction:.15,bladeCount:1
        }
      },
      SEESAW:{
        width:230,height:16,
        restitution:.34,friction:.08,
        visualFill:"#6b6650",visualStroke:"#c5bb86",
        props:{
          rotationMode:"FORCE_OSCILLATE",
          pivotRatio:0,angularSpeed:90,
          startAngle:-14,endAngle:14,period:4,
          motorTorque:30,jointFriction:.15,bladeCount:1
        }
      },
      HINGE:{
        width:220,height:16,
        restitution:.34,friction:.08,
        visualFill:"#47605b",visualStroke:"#8fc5b7",
        props:{
          rotationMode:"FREE",
          pivotRatio:-.48,angularSpeed:0,
          startAngle:-70,endAngle:70,period:3.2,
          motorTorque:0,jointFriction:.15,bladeCount:1
        }
      },
      PADDLE:{
        width:180,height:18,
        restitution:.45,friction:.06,
        visualFill:"#7a4936",visualStroke:"#e8996f",
        props:{
          rotationMode:"TORQUE_CONTINUOUS",
          pivotRatio:-.48,angularSpeed:180,
          startAngle:-70,endAngle:70,period:3.2,
          motorTorque:30,jointFriction:.05,bladeCount:1
        }
      }
    };
    if(rotationPresets[preset]){
      const cfg=rotationPresets[preset];
      const c=componentDefaults("ROTATIONAL_BODY",x,y);
      c.width=cfg.width;
      c.height=cfg.height;
      c.properties=colliderProperties(
        {
          ...cfg.props,
          rotationPreset:preset,
          visualFill:cfg.visualFill,
          visualStroke:cfg.visualStroke
        },
        {restitution:cfg.restitution,friction:cfg.friction}
      );
      c.properties.restitution=cfg.restitution;
      c.properties.friction=cfg.friction;
      return c;
    }

    return componentDefaults(preset,x,y);
  }

  function migratedColliderProperties(properties,defaults={}){
    return colliderProperties({...properties},defaults);
  }

  function migrateRotationComponent(component){
    const c=structuredClone(component);
    const p=c.properties||{};
    const sourceType=String(c.type||"").toUpperCase();
    const presetDefaults=createPreset(sourceType,c.x,c.y);
    const common={
      ...(presetDefaults?.properties||{}),
      ...p,
      rotationPreset:sourceType
    };
    let behavior=null;

    if(sourceType==="ROTATOR"){
      behavior={
        rotationMode:"FORCE_CONTINUOUS",
        pivotRatio:finiteOr(p.pivotRatio,0),
        angularSpeed:finiteOr(p.angularSpeed,90),
        startAngle:finiteOr(p.startAngle,-30),
        endAngle:finiteOr(p.endAngle,30),
        period:finiteOr(p.period,3.2),
        motorTorque:finiteOr(p.motorTorque,30),
        jointFriction:finiteOr(p.jointFriction,.15),
        bladeCount:Math.max(1,Math.min(4,Math.trunc(finiteOr(p.bladeCount,1))))
      };
    }else if(sourceType==="GATE"){
      behavior={
        rotationMode:"FORCE_OSCILLATE",
        pivotRatio:finiteOr(p.pivotRatio,-.5),
        angularSpeed:finiteOr(p.angularSpeed,90),
        startAngle:0,
        endAngle:finiteOr(p.openAngle,78),
        period:finiteOr(p.period,3.6),
        motorTorque:finiteOr(p.motorTorque,30),
        jointFriction:finiteOr(p.jointFriction,.15),
        bladeCount:1
      };
    }else if(sourceType==="PENDULUM"){
      const amplitude=finiteOr(p.amplitude,42);
      behavior={
        rotationMode:"FORCE_OSCILLATE",
        pivotRatio:finiteOr(p.pivotRatio,-.5),
        angularSpeed:finiteOr(p.angularSpeed,90),
        startAngle:-amplitude,
        endAngle:amplitude,
        period:finiteOr(p.period,3.2),
        motorTorque:finiteOr(p.motorTorque,30),
        jointFriction:finiteOr(p.jointFriction,.15),
        bladeCount:1
      };
    }else if(sourceType==="SEESAW"){
      const amplitude=finiteOr(p.amplitude,14);
      behavior={
        rotationMode:"FORCE_OSCILLATE",
        pivotRatio:finiteOr(p.pivotRatio,0),
        angularSpeed:finiteOr(p.angularSpeed,90),
        startAngle:-amplitude,
        endAngle:amplitude,
        period:finiteOr(p.period,4),
        motorTorque:finiteOr(p.motorTorque,30),
        jointFriction:finiteOr(p.jointFriction,.15),
        bladeCount:1
      };
    }else if(sourceType==="HINGE"){
      behavior={
        rotationMode:"FREE",
        pivotRatio:finiteOr(p.pivotRatio,-.48),
        angularSpeed:0,
        startAngle:finiteOr(p.lowerAngle,-70),
        endAngle:finiteOr(p.upperAngle,70),
        period:finiteOr(p.period,3.2),
        motorTorque:0,
        jointFriction:finiteOr(p.jointFriction,.15),
        bladeCount:1
      };
    }else if(sourceType==="PADDLE"){
      behavior={
        rotationMode:"TORQUE_CONTINUOUS",
        pivotRatio:finiteOr(p.pivotRatio,-.48),
        angularSpeed:finiteOr(p.motorSpeed,180),
        startAngle:finiteOr(p.lowerAngle,-70),
        endAngle:finiteOr(p.upperAngle,70),
        period:finiteOr(p.period,3.2),
        motorTorque:finiteOr(p.motorTorque,30),
        jointFriction:finiteOr(p.jointFriction,.05),
        bladeCount:1
      };
    }
    if(!behavior) return c;

    const {
      openAngle,amplitude,lowerAngle,upperAngle,motorSpeed,
      ...remaining
    }=common;
    c.type="ROTATIONAL_BODY";
    c.properties=migratedColliderProperties({
      ...remaining,
      ...behavior
    });
    return c;
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
      if(c.type==="ELIMINATION"){
        c.type="FINISH";
        c.properties={
          ...c.properties,
          sensorTag:String(
            c.properties.sensorTag
            || c.properties.eliminationKey
            || "FINISH"
          )
        };
        delete c.properties.eliminationKey;
      }
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
        c.type="ROTATIONAL_BODY";
        c.width=finiteOr(c.width,170);
        c.height=finiteOr(c.height,18);
        c.properties=migratedColliderProperties(
          {
            ...remaining,
            rotationPreset:"ROTATOR",
            rotationMode:"FORCE_CONTINUOUS",
            pivotRatio:0,
            angularSpeed:finiteOr(motorSpeed,120),
            startAngle:-30,
            endAngle:30,
            period:3.2,
            motorTorque:finiteOr(motorTorque,35),
            jointFriction:.15,
            bladeCount:2
          },
          {restitution:.4,friction:.06}
        );
        migrated.push(c);
        continue;
      }

      if(
        ["GATE","ROTATOR","PENDULUM","SEESAW","HINGE","PADDLE"]
          .includes(c.type)
      ){
        migrated.push(migrateRotationComponent(c));
        continue;
      }

      if(c.type==="ROTATIONAL_BODY"){
        const defaults=componentDefaults("ROTATIONAL_BODY",c.x,c.y);
        c.properties=migratedColliderProperties({
          ...defaults.properties,
          ...c.properties
        });
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

      if(c.type==="CURVE_WALL"){
        const curveMode=String(
          c.properties?.curveMode||"PARABOLA"
        ).toUpperCase();
        if(curveMode==="CIRCULAR_ARC"){
          const geometry=circularArcGeometry(c);
          c.properties=migratedColliderProperties({
            ...c.properties,
            curveMode,
            arcStartAngle:finiteOr(
              c.properties?.arcStartAngle,
              geometry.startAngle
            ),
            arcEndAngle:finiteOr(
              c.properties?.arcEndAngle,
              geometry.endAngle
            )
          });
        }else{
          c.properties=migratedColliderProperties({
            ...c.properties,
            curveMode:"PARABOLA",
            curveStartPercent:finiteOr(
              c.properties?.curveStartPercent,
              0
            ),
            curveEndPercent:finiteOr(
              c.properties?.curveEndPercent,
              100
            )
          });
        }
      }else if(isCollider(c)){
        c.properties=migratedColliderProperties(c.properties);
      }
      if(isDirectionalCollider(c)){
        const mode=String(
          c.properties?.collisionMode||"SOLID"
        ).toUpperCase();
        c.properties.collisionMode=
          mode==="ONE_WAY" ? "ONE_WAY" : "SOLID";
        c.properties.oneWayDirection=
          finiteOr(c.properties?.oneWayDirection,1)<0 ? -1 : 1;
      }else if(isCollider(c)){
        c.properties.collisionMode="SOLID";
        c.properties.oneWayDirection=1;
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
    return {"schemaVersion":"viewer-draw-machine-map/v1","name":"Retro Cadet Survivor V3","world":{"width":1440,"height":2560,"gravityX":0,"gravityY":12,"visualBackground":"#102758"},"drawRule":{"type":"RACE_FINISH","winnerCount":0},"runPolicy":{"timeoutSeconds":0,"qualificationMinWinners":1,"qualificationMaxNudges":0},"components":[{"id":"d023c3c5-92a9-44e8-9e3d-484202f35da3","type":"CIRCLE","x":702,"y":1770,"rotation":0,"width":0,"height":0,"radius":10,"properties":{"restitution":0.66,"friction":0.025,"boost":0,"soundMaterial":"metal","instrument":"click","audioNote":60,"audioGain":0.62,"audioPan":0.45,"visualFill":"#6bd6ff","visualStroke":"#fff1a3","collisionMode":"SOLID","oneWayDirection":1}},{"id":"de1e4c12-c276-444e-a718-1f407cbe2f75","type":"CIRCLE","x":693.4745076412642,"y":1812.8605444248901,"rotation":0,"width":0,"height":0,"radius":10,"properties":{"restitution":0.66,"friction":0.025,"boost":0,"soundMaterial":"metal","instrument":"click","audioNote":61,"audioGain":0.62,"audioPan":0.415745789630079,"visualFill":"#f0c436","visualStroke":"#fff1a3","collisionMode":"SOLID","oneWayDirection":1}},{"id":"16544eaa-7c4e-4cfa-a1ef-7e7dad4b8789","type":"CIRCLE","x":669.1959594928933,"y":1849.195959492893,"rotation":0,"width":0,"height":0,"radius":10,"properties":{"restitution":0.66,"friction":0.025,"boost":0,"soundMaterial":"metal","instrument":"click","audioNote":62,"audioGain":0.62,"audioPan":0.3181980515339464,"visualFill":"#6bd6ff","visualStroke":"#fff1a3","collisionMode":"SOLID","oneWayDirection":1}},{"id":"595df365-4c65-4906-950a-6ea2b39bf4d8","type":"CIRCLE","x":632.8605444248901,"y":1873.4745076412642,"rotation":0,"width":0,"height":0,"radius":10,"properties":{"restitution":0.66,"friction":0.025,"boost":0,"soundMaterial":"metal","instrument":"click","audioNote":63,"audioGain":0.62,"audioPan":0.17220754456429044,"visualFill":"#f0c436","visualStroke":"#fff1a3","collisionMode":"SOLID","oneWayDirection":1}},{"id":"569a1d59-e256-4421-b3a8-b28891ee4fac","type":"CIRCLE","x":590,"y":1882,"rotation":0,"width":0,"height":0,"radius":10,"properties":{"restitution":0.66,"friction":0.025,"boost":0,"soundMaterial":"metal","instrument":"click","audioNote":64,"audioGain":0.62,"audioPan":2.7554552980815448e-17,"visualFill":"#6bd6ff","visualStroke":"#fff1a3","collisionMode":"SOLID","oneWayDirection":1}},{"id":"ccf01329-b8d7-4f37-ba05-171ff1a20c47","type":"CIRCLE","x":547.1394555751099,"y":1873.4745076412642,"rotation":0,"width":0,"height":0,"radius":10,"properties":{"restitution":0.66,"friction":0.025,"boost":0,"soundMaterial":"metal","instrument":"click","audioNote":60,"audioGain":0.62,"audioPan":-0.17220754456429038,"visualFill":"#f0c436","visualStroke":"#fff1a3","collisionMode":"SOLID","oneWayDirection":1}},{"id":"4f395856-217d-42dd-bcc8-9a9fb3d7c6e2","type":"CIRCLE","x":510.8040405071067,"y":1849.195959492893,"rotation":0,"width":0,"height":0,"radius":10,"properties":{"restitution":0.66,"friction":0.025,"boost":0,"soundMaterial":"metal","instrument":"click","audioNote":61,"audioGain":0.62,"audioPan":-0.31819805153394637,"visualFill":"#6bd6ff","visualStroke":"#fff1a3","collisionMode":"SOLID","oneWayDirection":1}},{"id":"91d45417-d34a-4788-9d7f-b386f74d47a1","type":"CIRCLE","x":486.52549235873585,"y":1812.8605444248901,"rotation":0,"width":0,"height":0,"radius":10,"properties":{"restitution":0.66,"friction":0.025,"boost":0,"soundMaterial":"metal","instrument":"click","audioNote":62,"audioGain":0.62,"audioPan":-0.415745789630079,"visualFill":"#f0c436","visualStroke":"#fff1a3","collisionMode":"SOLID","oneWayDirection":1}},{"id":"926d7b73-8e35-4e70-add7-b29ac26ad245","type":"CIRCLE","x":478,"y":1770,"rotation":0,"width":0,"height":0,"radius":10,"properties":{"restitution":0.66,"friction":0.025,"boost":0,"soundMaterial":"metal","instrument":"click","audioNote":63,"audioGain":0.62,"audioPan":-0.45,"visualFill":"#6bd6ff","visualStroke":"#fff1a3","collisionMode":"SOLID","oneWayDirection":1}},{"id":"f96251ea-8b26-4b7a-8eb6-71e11a131032","type":"CIRCLE","x":486.52549235873585,"y":1727.1394555751099,"rotation":0,"width":0,"height":0,"radius":10,"properties":{"restitution":0.66,"friction":0.025,"boost":0,"soundMaterial":"metal","instrument":"click","audioNote":64,"audioGain":0.62,"audioPan":-0.4157457896300791,"visualFill":"#f0c436","visualStroke":"#fff1a3","collisionMode":"SOLID","oneWayDirection":1}},{"id":"eb4ff3ea-0aee-4d81-94e8-ad30c80a4f98","type":"CIRCLE","x":510.8040405071067,"y":1690.804040507107,"rotation":0,"width":0,"height":0,"radius":10,"properties":{"restitution":0.66,"friction":0.025,"boost":0,"soundMaterial":"metal","instrument":"click","audioNote":60,"audioGain":0.62,"audioPan":-0.3181980515339465,"visualFill":"#6bd6ff","visualStroke":"#fff1a3","collisionMode":"SOLID","oneWayDirection":1}},{"id":"5ae8235b-fc2e-4494-90a5-5f1785d83093","type":"CIRCLE","x":547.1394555751099,"y":1666.5254923587358,"rotation":0,"width":0,"height":0,"radius":10,"properties":{"restitution":0.66,"friction":0.025,"boost":0,"soundMaterial":"metal","instrument":"click","audioNote":61,"audioGain":0.62,"audioPan":-0.17220754456429066,"visualFill":"#f0c436","visualStroke":"#fff1a3","collisionMode":"SOLID","oneWayDirection":1}},{"id":"b0d50eea-920c-4fff-96df-f245b703d3ef","type":"CIRCLE","x":590,"y":1658,"rotation":0,"width":0,"height":0,"radius":10,"properties":{"restitution":0.66,"friction":0.025,"boost":0,"soundMaterial":"metal","instrument":"click","audioNote":62,"audioGain":0.62,"audioPan":-8.266365894244634e-17,"visualFill":"#6bd6ff","visualStroke":"#fff1a3","collisionMode":"SOLID","oneWayDirection":1}},{"id":"cc3291c7-10e4-412f-8558-2d2e9c115ac1","type":"CIRCLE","x":632.8605444248901,"y":1666.5254923587358,"rotation":0,"width":0,"height":0,"radius":10,"properties":{"restitution":0.66,"friction":0.025,"boost":0,"soundMaterial":"metal","instrument":"click","audioNote":63,"audioGain":0.62,"audioPan":0.1722075445642905,"visualFill":"#f0c436","visualStroke":"#fff1a3","collisionMode":"SOLID","oneWayDirection":1}},{"id":"ff444c2c-c1d0-4634-83c7-5c3de79e4c88","type":"CIRCLE","x":669.1959594928933,"y":1690.804040507107,"rotation":0,"width":0,"height":0,"radius":10,"properties":{"restitution":0.66,"friction":0.025,"boost":0,"soundMaterial":"metal","instrument":"click","audioNote":64,"audioGain":0.62,"audioPan":0.3181980515339463,"visualFill":"#6bd6ff","visualStroke":"#fff1a3","collisionMode":"SOLID","oneWayDirection":1}},{"id":"744dc10b-dfd5-45e1-b42f-ce0ed23e635c","type":"CIRCLE","x":693.4745076412642,"y":1727.1394555751099,"rotation":0,"width":0,"height":0,"radius":10,"properties":{"restitution":0.66,"friction":0.025,"boost":0,"soundMaterial":"metal","instrument":"click","audioNote":60,"audioGain":0.62,"audioPan":0.41574578963007897,"visualFill":"#f0c436","visualStroke":"#fff1a3","collisionMode":"SOLID","oneWayDirection":1}},{"id":"7b410634-dc9f-46c6-929a-29e7d57d8b05","type":"CIRCLE","x":590,"y":1770,"rotation":0,"width":0,"height":0,"radius":52,"properties":{"restitution":0.9,"friction":0.02,"boost":1.12,"soundMaterial":"metal","instrument":"chime","audioNote":64,"audioGain":0.85,"audioPan":-0.05,"visualFill":"#238eae","visualStroke":"#72dcf5","collisionMode":"SOLID","oneWayDirection":1}},{"id":"f0fe5fce-dc01-4dfc-af41-fc46884b6a3e","type":"CIRCLE","x":590,"y":1770,"rotation":0,"width":0,"height":0,"radius":24,"properties":{"restitution":0.82,"friction":0.025,"boost":1.03,"soundMaterial":"glass","instrument":"bell","audioNote":76,"audioGain":0.6,"audioPan":-0.05,"visualFill":"#42b9d4","visualStroke":"#b0f5ff","collisionMode":"SOLID","oneWayDirection":1}},{"id":"dad6e709-6840-4ad7-9021-bd8df547be5f","type":"FINISH","x":590,"y":2545,"rotation":0,"width":240,"height":30,"radius":0,"properties":{"eliminationKey":"CENTER_DRAIN","sensorTag":"CENTER_DRAIN","soundMaterial":"metal","instrument":"drum","audioNote":43,"audioGain":1.12,"audioPan":-0.05,"visualFill":"#05070b","visualStroke":"#d15378"}},{"id":"0974d44a-a029-4667-bde8-b864f9e7e674","type":"BURST_SPAWN","x":1295,"y":2480,"rotation":0,"width":0,"height":0,"radius":20,"properties":{"marbleRadius":11,"spawnRole":"BURST","burstDirectionDegrees":-90,"burstSpreadDegrees":24,"burstPower":20,"burstPowerVariance":0.22,"burstSizeMin":3,"burstSizeMax":7,"burstIntervalMs":150,"visualFill":"#784878","visualStroke":"#e092df"}},{"id":"d3c7a90b-30ff-4a2a-ae48-54dc35a90c91","type":"CURVE_WALL","x":720,"y":355,"rotation":0,"width":1420,"height":670,"radius":0,"properties":{"restitution":0.35,"friction":0.06,"boost":0,"curveMode":"CIRCULAR_ARC","thickness":18,"segments":24,"visualFill":"#3f6676","visualStroke":"#78c9e8","soundMaterial":"metal","instrument":"none","audioNote":60,"audioGain":1,"audioPan":0,"arcStartAngle":184,"arcEndAngle":4,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"9aab80ab-7284-4daf-aaf7-c080b6e0eb2c","type":"WALL","x":1430,"y":1610,"rotation":90,"width":1900,"height":18,"radius":0,"properties":{"restitution":0.35,"friction":0.03,"boost":1,"visualFill":"#6f7c87","visualStroke":"#a6b0b8","soundMaterial":"metal","instrument":"none","audioNote":60,"audioGain":1,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"54a0f878-18c7-49f4-a292-b15f080be8ca","type":"WALL","x":10,"y":1610,"rotation":90,"width":1900,"height":18,"radius":0,"properties":{"restitution":0.35,"friction":0.06,"boost":0,"visualFill":"#6f7c87","visualStroke":"#a6b0b8","soundMaterial":"metal","instrument":"none","audioNote":60,"audioGain":1,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"3209221e-0bb6-42d8-833b-c4fb8493946d","type":"WALL","x":274.6446609406726,"y":2334.6446609406726,"rotation":45,"width":550,"height":18,"radius":0,"properties":{"restitution":0.35,"friction":0.06,"boost":0,"visualFill":"#6f7c87","visualStroke":"#a6b0b8","soundMaterial":"metal","instrument":"none","audioNote":60,"audioGain":1,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"5720f6a0-b16d-49c7-b377-59bdc888dedf","type":"WALL","x":905.3553390593274,"y":2334.6446609406726,"rotation":-45,"width":550,"height":18,"radius":0,"properties":{"restitution":0.35,"friction":0.06,"boost":0,"visualFill":"#6f7c87","visualStroke":"#a6b0b8","soundMaterial":"metal","instrument":"none","audioNote":60,"audioGain":1,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"9453268a-62e7-487d-a13f-657bc8b5af78","type":"WALL","x":150,"y":2382,"rotation":90,"width":356,"height":18,"radius":0,"properties":{"restitution":0.35,"friction":0.06,"boost":0,"visualFill":"#6f7c87","visualStroke":"#a6b0b8","soundMaterial":"metal","instrument":"none","audioNote":60,"audioGain":1,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"dba7c3d9-d820-4ec4-9f9b-8332fa225003","type":"WALL","x":1030,"y":2382,"rotation":90,"width":356,"height":18,"radius":0,"properties":{"restitution":0.35,"friction":0.06,"boost":0,"visualFill":"#6f7c87","visualStroke":"#a6b0b8","soundMaterial":"metal","instrument":"none","audioNote":60,"audioGain":1,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"4f7dbe4b-2f12-47a7-be0a-9247bf614314","type":"WALL","x":80,"y":2550,"rotation":0,"width":120,"height":18,"radius":0,"properties":{"restitution":2,"friction":0.05,"boost":18,"visualFill":"#3e6675","visualStroke":"#78bdd5","soundMaterial":"metal","instrument":"none","audioNote":60,"audioGain":1,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"0d0f8102-0f17-4025-9048-04668ec78d6e","type":"WALL","x":1230,"y":2550,"rotation":0,"width":380,"height":18,"radius":0,"properties":{"restitution":2,"friction":0.05,"boost":20,"visualFill":"#3e6675","visualStroke":"#78bdd5","soundMaterial":"metal","instrument":"none","audioNote":60,"audioGain":1,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"136d6987-fbb3-4767-907b-bce20bfd730b","type":"WALL","x":285.25,"y":2205.25,"rotation":45,"width":380,"height":18,"radius":0,"properties":{"restitution":0.35,"friction":0.01,"boost":0,"visualFill":"#6f7c87","visualStroke":"#a6b0b8","soundMaterial":"metal","instrument":"none","audioNote":60,"audioGain":1,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"3c90333a-0dcc-41f4-b749-644201e8ef6f","type":"WALL","x":894.75,"y":2205.25,"rotation":-45,"width":380,"height":18,"radius":0,"properties":{"restitution":0.35,"friction":0.01,"boost":0,"visualFill":"#6f7c87","visualStroke":"#a6b0b8","soundMaterial":"metal","instrument":"none","audioNote":60,"audioGain":1,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"dded39c1-66fb-4ba3-a36f-71172e27cbf2","type":"WALL","x":1160,"y":1665,"rotation":90,"width":1750,"height":18,"radius":0,"properties":{"restitution":0.35,"friction":0.03,"boost":1,"visualFill":"#6f7c87","visualStroke":"#a6b0b8","soundMaterial":"metal","instrument":"none","audioNote":60,"audioGain":1,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"fadc5886-bcd8-41fb-a515-1fd9fa642c2b","type":"ROTATIONAL_BODY","x":1290,"y":770,"rotation":-10,"width":270,"height":18,"radius":0,"properties":{"restitution":0.34,"friction":0.01,"boost":0,"rotationPreset":"HINGE","rotationMode":"FREE","pivotRatio":-0.48,"angularSpeed":0,"startAngle":-79.8,"endAngle":0,"period":3.2,"phase":0,"motorTorque":0,"jointFriction":0.6,"bladeCount":1,"visualFill":"#47605b","visualStroke":"#8fc5b7","soundMaterial":"metal","instrument":"none","audioNote":60,"audioGain":1,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"2a7860e0-d5bf-4116-8b27-c09837e95879","type":"ROTATIONAL_BODY","x":470.61,"y":2390.61,"rotation":-45,"width":18,"height":150,"radius":0,"properties":{"restitution":0.8,"friction":0.02,"boost":1,"rotationMode":"FORCE_OSCILLATE","pivotRatio":-0.5,"angularSpeed":90,"startAngle":-45,"endAngle":0,"period":0.8,"motorTorque":30,"jointFriction":0.15,"bladeCount":1,"rotationPreset":"PENDULUM","visualFill":"#496b8f","visualStroke":"#82b6e9","soundMaterial":"metal","instrument":"none","audioNote":60,"audioGain":1,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1,"phase":0}},{"id":"641af7e1-b48a-4757-99a9-c4329cb9b300","type":"ROTATIONAL_BODY","x":709.39,"y":2390.61,"rotation":45,"width":18,"height":150,"radius":0,"properties":{"restitution":0.8,"friction":0.02,"boost":1,"rotationMode":"FORCE_OSCILLATE","pivotRatio":-0.5,"angularSpeed":90,"startAngle":45,"endAngle":0,"period":0.8,"motorTorque":30,"jointFriction":0.15,"bladeCount":1,"rotationPreset":"PENDULUM","visualFill":"#496b8f","visualStroke":"#82b6e9","soundMaterial":"metal","instrument":"none","audioNote":60,"audioGain":1,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1,"phase":0}},{"id":"3e67a631-11fa-42eb-a707-3619f4e4900a","type":"WALL","x":150,"y":1945,"rotation":90,"width":260,"height":18,"radius":0,"properties":{"restitution":0.35,"friction":0.06,"boost":0,"visualFill":"#6f7c87","visualStroke":"#a6b0b8","soundMaterial":"metal","instrument":"none","audioNote":60,"audioGain":1,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"4af6a747-8377-442d-9426-b1dcdcc061c8","type":"WALL","x":1030,"y":1945,"rotation":90,"width":260,"height":18,"radius":0,"properties":{"restitution":0.35,"friction":0.06,"boost":0,"visualFill":"#6f7c87","visualStroke":"#a6b0b8","soundMaterial":"metal","instrument":"none","audioNote":60,"audioGain":1,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"87b4c2e8-39dd-4e91-b24e-006b2635bdf5","type":"WALL","x":230,"y":1930,"rotation":90,"width":230,"height":18,"radius":0,"properties":{"restitution":0.35,"friction":0.06,"boost":0,"visualFill":"#6f7c87","visualStroke":"#a6b0b8","soundMaterial":"metal","instrument":"none","audioNote":60,"audioGain":1,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"04558d36-5776-4ad9-ab2d-ca40d9317fb4","type":"WALL","x":950,"y":1930,"rotation":90,"width":230,"height":18,"radius":0,"properties":{"restitution":0.35,"friction":0.06,"boost":0,"visualFill":"#6f7c87","visualStroke":"#a6b0b8","soundMaterial":"metal","instrument":"none","audioNote":60,"audioGain":1,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"3fa2943e-40cf-4ae6-b762-44ef575499a3","type":"WALL","x":310,"y":1930,"rotation":90,"width":230,"height":18,"radius":0,"properties":{"restitution":0.35,"friction":0.06,"boost":0,"visualFill":"#6f7c87","visualStroke":"#a6b0b8","soundMaterial":"metal","instrument":"none","audioNote":60,"audioGain":1,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"d49a4cd1-b7c1-486e-9e36-707ab1ea6cf6","type":"WALL","x":870,"y":1930,"rotation":90,"width":230,"height":18,"radius":0,"properties":{"restitution":0.35,"friction":0.06,"boost":0,"visualFill":"#6f7c87","visualStroke":"#a6b0b8","soundMaterial":"metal","instrument":"none","audioNote":60,"audioGain":1,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"de4e0a80-af4a-4f0f-85b7-2a4cf6975d09","type":"WALL","x":361.1091270347399,"y":2091.1091270347397,"rotation":45,"width":150,"height":18,"radius":0,"properties":{"restitution":0.35,"friction":0.06,"boost":0,"visualFill":"#6f7c87","visualStroke":"#a6b0b8","soundMaterial":"metal","instrument":"none","audioNote":60,"audioGain":1,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"31228521-cca1-4fe7-926c-11563f887f0c","type":"WALL","x":818.8908729652601,"y":2091.1091270347397,"rotation":-45,"width":150,"height":18,"radius":0,"properties":{"restitution":0.35,"friction":0.06,"boost":0,"visualFill":"#6f7c87","visualStroke":"#a6b0b8","soundMaterial":"metal","instrument":"none","audioNote":60,"audioGain":1,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"bced0fcb-8a41-4880-afa0-98b9c8af36b6","type":"WALL","x":363.99,"y":1974.62,"rotation":72,"width":360,"height":22,"radius":0,"properties":{"restitution":1.2,"friction":0.01,"boost":5,"visualFill":"#3e6675","visualStroke":"#78bdd5","soundMaterial":"metal","instrument":"none","audioNote":60,"audioGain":1,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"2f4f1adf-742c-4a4c-89ab-696f2561e38c","type":"WALL","x":816.01,"y":1974.62,"rotation":-72,"width":360,"height":22,"radius":0,"properties":{"restitution":1.2,"friction":0.01,"boost":5,"visualFill":"#3e6675","visualStroke":"#78bdd5","soundMaterial":"metal","instrument":"none","audioNote":60,"audioGain":1,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"28412776-d7bb-5036-b97a-7ef61687efc0","type":"ROTATIONAL_BODY","x":590,"y":1200,"rotation":0,"width":170,"height":16,"radius":0,"properties":{"restitution":0.62,"friction":0.05,"boost":0,"rotationPreset":"ROTATOR","rotationMode":"TORQUE_CONTINUOUS","pivotRatio":0,"angularSpeed":78,"startAngle":-45,"endAngle":45,"period":3.2,"phase":0,"motorTorque":300,"jointFriction":0.15,"bladeCount":2,"visualFill":"#6941a9","visualStroke":"#c49cff","soundMaterial":"metal","instrument":"click","audioNote":62,"audioGain":0.75,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"076c69f5-778e-5dc4-a995-80b117a66153","type":"CIRCLE","x":480,"y":1200,"rotation":0,"width":0,"height":0,"radius":14,"properties":{"restitution":0.7,"friction":0.025,"boost":0,"soundMaterial":"metal","instrument":"click","audioNote":62,"audioGain":0.9,"audioPan":-0.25,"visualFill":"#e45d69","visualStroke":"#ffb0b6","collisionMode":"SOLID","oneWayDirection":1}},{"id":"f26b2d49-ea35-5267-ae10-c35a5b26c6c8","type":"CIRCLE","x":700,"y":1200,"rotation":0,"width":0,"height":0,"radius":14,"properties":{"restitution":0.7,"friction":0.025,"boost":0,"soundMaterial":"metal","instrument":"click","audioNote":64,"audioGain":0.9,"audioPan":0.25,"visualFill":"#e45d69","visualStroke":"#ffb0b6","collisionMode":"SOLID","oneWayDirection":1}},{"id":"e3c1df6b-03d3-55b8-8e11-30aa0076153d","type":"CIRCLE","x":450,"y":1500,"rotation":0,"width":0,"height":0,"radius":15,"properties":{"restitution":0.82,"friction":0.025,"boost":0.35,"soundMaterial":"metal","instrument":"click","audioNote":60,"audioGain":0.6,"audioPan":-0.2,"visualFill":"#f0d450","visualStroke":"#fff0a1","collisionMode":"SOLID","oneWayDirection":1}},{"id":"9a58abaa-85eb-54ca-b59e-d441841039af","type":"CIRCLE","x":520,"y":1455,"rotation":0,"width":0,"height":0,"radius":15,"properties":{"restitution":0.82,"friction":0.025,"boost":0.35,"soundMaterial":"metal","instrument":"click","audioNote":61,"audioGain":0.6,"audioPan":-0.1,"visualFill":"#e45d69","visualStroke":"#ffb0b6","collisionMode":"SOLID","oneWayDirection":1}},{"id":"97b84c2b-256f-5507-96bd-afb1197efa91","type":"CIRCLE","x":590,"y":1440,"rotation":0,"width":0,"height":0,"radius":15,"properties":{"restitution":0.82,"friction":0.025,"boost":0.35,"soundMaterial":"metal","instrument":"click","audioNote":62,"audioGain":0.6,"audioPan":0,"visualFill":"#f0d450","visualStroke":"#fff0a1","collisionMode":"SOLID","oneWayDirection":1}},{"id":"d8028906-a7af-507e-bbc8-e1865b1c8767","type":"CIRCLE","x":660,"y":1455,"rotation":0,"width":0,"height":0,"radius":15,"properties":{"restitution":0.82,"friction":0.025,"boost":0.35,"soundMaterial":"metal","instrument":"click","audioNote":63,"audioGain":0.6,"audioPan":0.1,"visualFill":"#e45d69","visualStroke":"#ffb0b6","collisionMode":"SOLID","oneWayDirection":1}},{"id":"185ed312-2077-516d-81ea-b57a7153ab55","type":"CIRCLE","x":730,"y":1500,"rotation":0,"width":0,"height":0,"radius":15,"properties":{"restitution":0.82,"friction":0.025,"boost":0.35,"soundMaterial":"metal","instrument":"click","audioNote":64,"audioGain":0.6,"audioPan":0.2,"visualFill":"#f0d450","visualStroke":"#fff0a1","collisionMode":"SOLID","oneWayDirection":1}},{"id":"3e2c057a-9dc5-4d2e-9ad8-dc4294b5a6bb","type":"ROTATIONAL_BODY","x":810,"y":1200,"rotation":0,"width":170,"height":16,"radius":0,"properties":{"restitution":0.62,"friction":0.05,"boost":0,"rotationPreset":"ROTATOR","rotationMode":"TORQUE_CONTINUOUS","pivotRatio":0,"angularSpeed":78,"startAngle":-45,"endAngle":45,"period":3.2,"phase":0,"motorTorque":300,"jointFriction":0.15,"bladeCount":2,"visualFill":"#6941a9","visualStroke":"#c49cff","soundMaterial":"metal","instrument":"click","audioNote":62,"audioGain":0.75,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"b1a03df6-e22e-49ad-a250-74091789da1d","type":"CIRCLE","x":920,"y":1200,"rotation":0,"width":0,"height":0,"radius":14,"properties":{"restitution":0.7,"friction":0.025,"boost":0,"soundMaterial":"metal","instrument":"click","audioNote":64,"audioGain":0.9,"audioPan":0.25,"visualFill":"#e45d69","visualStroke":"#ffb0b6","collisionMode":"SOLID","oneWayDirection":1}},{"id":"8b7f226b-323c-4b3f-acf6-5f6367429694","type":"ROTATIONAL_BODY","x":370,"y":1200,"rotation":0,"width":170,"height":16,"radius":0,"properties":{"restitution":0.62,"friction":0.05,"boost":0,"rotationPreset":"ROTATOR","rotationMode":"TORQUE_CONTINUOUS","pivotRatio":0,"angularSpeed":78,"startAngle":-45,"endAngle":45,"period":3.2,"phase":0,"motorTorque":300,"jointFriction":0.15,"bladeCount":2,"visualFill":"#6941a9","visualStroke":"#c49cff","soundMaterial":"metal","instrument":"click","audioNote":62,"audioGain":0.75,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"bf5cab57-eae1-43d3-8a5d-422c89715716","type":"CIRCLE","x":260,"y":1200,"rotation":0,"width":0,"height":0,"radius":14,"properties":{"restitution":0.7,"friction":0.025,"boost":0,"soundMaterial":"metal","instrument":"click","audioNote":62,"audioGain":0.9,"audioPan":-0.25,"visualFill":"#e45d69","visualStroke":"#ffb0b6","collisionMode":"SOLID","oneWayDirection":1}},{"id":"7fd9df2e-79b8-4f96-9e05-9bff7b1bdd2c","type":"CURVE_WALL","x":635,"y":240,"rotation":0,"width":1020,"height":390,"radius":0,"properties":{"restitution":0.35,"friction":0.01,"boost":0,"curveMode":"CIRCULAR_ARC","thickness":18,"segments":24,"visualFill":"#3f6676","visualStroke":"#78c9e8","soundMaterial":"metal","instrument":"none","audioNote":60,"audioGain":1,"audioPan":0,"arcStartAngle":300,"arcEndAngle":355,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"69c68626-ce66-4c2a-a9fa-c7f6cfa67337","type":"ROTATIONAL_BODY","x":150,"y":1200,"rotation":0,"width":170,"height":16,"radius":0,"properties":{"restitution":0.62,"friction":0.05,"boost":0,"rotationPreset":"ROTATOR","rotationMode":"TORQUE_CONTINUOUS","pivotRatio":0,"angularSpeed":78,"startAngle":-45,"endAngle":45,"period":3.2,"phase":0,"motorTorque":300,"jointFriction":0.15,"bladeCount":2,"visualFill":"#6941a9","visualStroke":"#c49cff","soundMaterial":"metal","instrument":"click","audioNote":62,"audioGain":0.75,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"2f636397-0bb6-4f83-bd9d-e82c69c63906","type":"ROTATIONAL_BODY","x":1030,"y":1200,"rotation":0,"width":170,"height":16,"radius":0,"properties":{"restitution":0.62,"friction":0.05,"boost":0,"rotationPreset":"ROTATOR","rotationMode":"TORQUE_CONTINUOUS","pivotRatio":0,"angularSpeed":78,"startAngle":-45,"endAngle":45,"period":3.2,"phase":0,"motorTorque":300,"jointFriction":0.15,"bladeCount":2,"visualFill":"#6941a9","visualStroke":"#c49cff","soundMaterial":"metal","instrument":"click","audioNote":62,"audioGain":0.75,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"8a224189-abde-4f3b-9bbf-0eebb225cdea","type":"ROTATIONAL_BODY","x":470,"y":990,"rotation":0,"width":180,"height":16,"radius":0,"properties":{"restitution":0.62,"friction":0.05,"boost":0,"rotationPreset":"ROTATOR","rotationMode":"TORQUE_CONTINUOUS","pivotRatio":0,"angularSpeed":-78,"startAngle":-45,"endAngle":45,"period":3.2,"phase":0,"motorTorque":300,"jointFriction":0.15,"bladeCount":2,"visualFill":"#6941a9","visualStroke":"#c49cff","soundMaterial":"metal","instrument":"click","audioNote":62,"audioGain":0.75,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"ff307e72-5804-4046-ac59-eb4208b9a4a3","type":"CIRCLE","x":350,"y":990,"rotation":0,"width":0,"height":0,"radius":14,"properties":{"restitution":0.7,"friction":0.025,"boost":0,"soundMaterial":"metal","instrument":"click","audioNote":62,"audioGain":0.9,"audioPan":-0.25,"visualFill":"#e45d69","visualStroke":"#ffb0b6","collisionMode":"SOLID","oneWayDirection":1}},{"id":"e5b99e92-2eb1-4589-9f0f-b7b0284275e9","type":"CIRCLE","x":590,"y":990,"rotation":0,"width":0,"height":0,"radius":14,"properties":{"restitution":0.7,"friction":0.025,"boost":0,"soundMaterial":"metal","instrument":"click","audioNote":64,"audioGain":0.9,"audioPan":0.25,"visualFill":"#e45d69","visualStroke":"#ffb0b6","collisionMode":"SOLID","oneWayDirection":1}},{"id":"d6bc7149-0199-4eb3-8da9-1e1d1e36b148","type":"ROTATIONAL_BODY","x":710,"y":990,"rotation":0,"width":180,"height":16,"radius":0,"properties":{"restitution":0.62,"friction":0.05,"boost":0,"rotationPreset":"ROTATOR","rotationMode":"TORQUE_CONTINUOUS","pivotRatio":0,"angularSpeed":-78,"startAngle":-45,"endAngle":45,"period":3.2,"phase":0,"motorTorque":300,"jointFriction":0.15,"bladeCount":2,"visualFill":"#6941a9","visualStroke":"#c49cff","soundMaterial":"metal","instrument":"click","audioNote":62,"audioGain":0.75,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"995ceff4-72a3-43a5-a6fd-35204052b517","type":"CIRCLE","x":830,"y":990,"rotation":0,"width":0,"height":0,"radius":14,"properties":{"restitution":0.7,"friction":0.025,"boost":0,"soundMaterial":"metal","instrument":"click","audioNote":64,"audioGain":0.9,"audioPan":0.25,"visualFill":"#e45d69","visualStroke":"#ffb0b6","collisionMode":"SOLID","oneWayDirection":1}},{"id":"856d3dd4-bd36-41b9-9210-8b6b6834cb0a","type":"ROTATIONAL_BODY","x":230,"y":990,"rotation":0,"width":180,"height":16,"radius":0,"properties":{"restitution":0.62,"friction":0.05,"boost":0,"rotationPreset":"ROTATOR","rotationMode":"TORQUE_CONTINUOUS","pivotRatio":0,"angularSpeed":-78,"startAngle":-45,"endAngle":45,"period":3.2,"phase":0,"motorTorque":300,"jointFriction":0.15,"bladeCount":2,"visualFill":"#6941a9","visualStroke":"#c49cff","soundMaterial":"metal","instrument":"click","audioNote":62,"audioGain":0.75,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"53581be0-ec9e-413f-830a-b1f200134032","type":"ROTATIONAL_BODY","x":950,"y":990,"rotation":0,"width":180,"height":16,"radius":0,"properties":{"restitution":0.62,"friction":0.05,"boost":0,"rotationPreset":"ROTATOR","rotationMode":"TORQUE_CONTINUOUS","pivotRatio":0,"angularSpeed":-78,"startAngle":-45,"endAngle":45,"period":3.2,"phase":0,"motorTorque":300,"jointFriction":0.15,"bladeCount":2,"visualFill":"#6941a9","visualStroke":"#c49cff","soundMaterial":"metal","instrument":"click","audioNote":62,"audioGain":0.75,"audioPan":0,"collisionMode":"SOLID","oneWayDirection":1}},{"id":"20128969-b7ea-452a-9970-21b7b97c2f78","type":"CIRCLE","x":110,"y":990,"rotation":0,"width":0,"height":0,"radius":14,"properties":{"restitution":0.7,"friction":0.025,"boost":0,"soundMaterial":"metal","instrument":"click","audioNote":64,"audioGain":0.9,"audioPan":0.25,"visualFill":"#e45d69","visualStroke":"#ffb0b6","collisionMode":"SOLID","oneWayDirection":1}},{"id":"de90158c-889a-4dd0-a97e-f6a96c8bf0e1","type":"CIRCLE","x":1070,"y":990,"rotation":0,"width":0,"height":0,"radius":14,"properties":{"restitution":0.7,"friction":0.025,"boost":0,"soundMaterial":"metal","instrument":"click","audioNote":64,"audioGain":0.9,"audioPan":0.25,"visualFill":"#e45d69","visualStroke":"#ffb0b6","collisionMode":"SOLID","oneWayDirection":1}}]};
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
    }else if(w<0||h<0){
      errors.push("World 너비와 높이는 0 이상이어야 합니다.");
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
      }else if(rotation<-360||rotation>360){
        errors.push("회전각은 -360~360° 범위여야 합니다.");
      }
      if(["WALL","CURVE_WALL","FINISH","ROTATIONAL_BODY","CONVEYOR","ELEVATOR","OUTPUT","SLOT","ELIMINATION"].includes(c?.type)){
        const cw=Number(c?.width),ch=Number(c?.height);
        if(!Number.isFinite(cw)||!Number.isFinite(ch)){
          errors.push("사각형 컴포넌트 크기는 유한 숫자여야 합니다.");
        }else if(cw<0||ch<0){
          errors.push("너비와 높이는 0 이상이어야 합니다.");
        }
      }
      if(["CIRCLE","SPAWN","BURST_SPAWN"].includes(c?.type)){
        const radius=Number(c?.radius);
        if(!Number.isFinite(radius)){
          errors.push("원형 컴포넌트 radius는 유한 숫자여야 합니다.");
        }else if(radius<0){
          errors.push("반지름은 0 이상이어야 합니다.");
        }
      }
      const p=c?.properties||{};
      if(isCollider(c)){
        const restitution=finiteOr(p.restitution,.35);
        const friction=finiteOr(p.friction,.05);
        const boost=finiteOr(p.boost,0);
        if(restitution<0) errors.push("탄성은 0 이상이어야 합니다.");
        if(friction<0) errors.push("마찰은 0 이상이어야 합니다.");
        if(boost<0) errors.push("Boost는 0 이상이어야 합니다.");
      }
      if(c?.type==="CURVE_WALL"){
        const curveMode=String(p.curveMode||"PARABOLA").toUpperCase();
        if(!["PARABOLA","CIRCULAR_ARC"].includes(curveMode)){
          errors.push("곡선 방식이 유효하지 않습니다.");
        }
        const thickness=Number(p.thickness ?? 18);
        const segments=Number(p.segments ?? 16);
        if(!Number.isFinite(thickness)||thickness<=0){
          errors.push("곡선 두께는 0보다 커야 합니다.");
        }
        if(!Number.isInteger(segments)||segments<6||segments>32){
          errors.push("곡선 세그먼트 수는 6~32 정수여야 합니다.");
        }
        if(curveMode==="CIRCULAR_ARC"){
          const start=Number(p.arcStartAngle);
          const end=Number(p.arcEndAngle);
          if(
            !Number.isFinite(start)||!Number.isFinite(end)
            || start<0||start>360||end<0||end>360
          ){
            errors.push("원호 시작/종료 각도는 0~360° 범위여야 합니다.");
          }
        }else{
          const start=Number(p.curveStartPercent ?? 0);
          const end=Number(p.curveEndPercent ?? 100);
          if(
            !Number.isFinite(start)||!Number.isFinite(end)
            || start<0||start>100||end<0||end>100
          ){
            errors.push("포물선 시작/종료 구간은 0~100% 범위여야 합니다.");
          }else if(Math.abs(start-end)<1e-9){
            errors.push("포물선 시작/종료 구간은 서로 달라야 합니다.");
          }
        }
      }
      if(c?.type==="ROTATIONAL_BODY"){
        const rawMode=String(
          p.rotationMode ?? "FORCE_CONTINUOUS"
        ).toUpperCase();
        const mode=rotationMode(c);
        const bladeCount=Number(p.bladeCount ?? 1);
        const pivotRatio=Number(p.pivotRatio ?? 0);
        const startAngle=Number(p.startAngle ?? -30);
        const endAngle=Number(p.endAngle ?? 30);
        const period=Number(p.period ?? 3.2);
        const torque=Number(p.motorTorque ?? 30);
        const frictionValue=Number(p.jointFriction ?? .15);

        if(!ROTATION_MODES.has(rawMode)){
          errors.push("회전 방식이 유효하지 않습니다.");
        }
        if(
          !Number.isInteger(bladeCount)
          || bladeCount<1
          || bladeCount>4
        ){
          errors.push("회전판 수는 1~4 정수여야 합니다.");
        }
        if(!Number.isFinite(pivotRatio)){
          errors.push("피벗 위치는 유한 숫자여야 합니다.");
        }
        if(
          !Number.isFinite(startAngle)
          || !Number.isFinite(endAngle)
          || startAngle<-360 || startAngle>360
          || endAngle<-360 || endAngle>360
        ){
          errors.push("회전 시작/종료 각도는 -360~360° 범위여야 합니다.");
        }
        if(!Number.isFinite(period)||period<0){
          errors.push("회전 주기는 0 이상이어야 합니다.");
        }
        if(!Number.isFinite(torque)||torque<0){
          errors.push("회전 토크는 0 이상이어야 합니다.");
        }
        if(!Number.isFinite(frictionValue)||frictionValue<0){
          errors.push("관절 마찰은 0 이상이어야 합니다.");
        }
      }

      if(p.burstDirectionDegrees!==undefined){
        const value=Number(p.burstDirectionDegrees);
        if(!Number.isFinite(value)||value<-360||value>360){
          errors.push("버스트 방향은 -360~360° 범위여야 합니다.");
        }
      }
      if(p.axisAngle!==undefined){
        const value=Number(p.axisAngle);
        if(!Number.isFinite(value)||value<-360||value>360){
          errors.push("이동 방향은 -360~360° 범위여야 합니다.");
        }
      }
      if(p.burstSpreadDegrees!==undefined){
        const value=Number(p.burstSpreadDegrees);
        if(!Number.isFinite(value)||value<0||value>360){
          errors.push("버스트 분산은 0~360° 범위여야 합니다.");
        }
      }
      const nonNegativeProperties=[
        ["thickness","두께"],
        ["marbleRadius","구슬 반지름"],
        ["burstPower","버스트 세기"],
        ["burstPowerVariance","버스트 세기 편차"],
        ["beltGrip","벨트 마찰 전달값"]
      ];
      for(const [key,label] of nonNegativeProperties){
        if(p[key]===undefined) continue;
        const value=Number(p[key]);
        if(!Number.isFinite(value)||value<0){
          errors.push(label+"은 0 이상이어야 합니다.");
        }
      }
      if(isDirectionalCollider(c)){
        const collisionMode=String(
          p.collisionMode||"SOLID"
        ).toUpperCase();
        if(!["SOLID","ONE_WAY"].includes(collisionMode)){
          errors.push(
            c.type+" collisionMode이 유효하지 않습니다."
          );
        }
        if(collisionMode==="ONE_WAY"){
          const direction=Number(p.oneWayDirection);
          if(direction!==1&&direction!==-1){
            errors.push(
              "ONE_WAY "+c.type
              +" oneWayDirection은 1 또는 -1이어야 합니다."
            );
          }
        }
      }else if(
        isCollider(c)
        && String(p.collisionMode||"SOLID").toUpperCase()
          !== "SOLID"
      ){
        errors.push(
          c.type+"은 ONE_WAY 충돌 모드를 지원하지 않습니다."
        );
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
      if(note<24||note>108) errors.push("audioNote는 MIDI 24~108 범위여야 합니다.");
      if(gain<0||gain>2) errors.push("audioGain은 0~2 범위여야 합니다.");
      if(pan<-1||pan>1) errors.push("audioPan은 -1~1 범위여야 합니다.");

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

    if(spawn!==1) errors.push("SPAWN/BURST_SPAWN은 정확히 1개 필요합니다.");
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
      if(!finish) errors.push("LAST_SURVIVOR에는 FINISH가 최소 1개 필요합니다.");
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

  function validateWarnings(def){
    const warnings=[];
    const world=def?.world||{};
    const w=Number(world.width),h=Number(world.height);
    const gx=Number(world.gravityX),gy=Number(world.gravityY);
    if(Number.isFinite(w)&&Number.isFinite(h)&&(w<320||w>3840||h<240||h>2160)){
      warnings.push("World 권장 크기는 320~3840 × 240~2160입니다.");
    }
    if(Number.isFinite(gx)&&Number.isFinite(gy)&&(Math.abs(gx)>50||Math.abs(gy)>50)){
      warnings.push("중력 권장 범위는 -50~50입니다.");
    }
    const rule=resolvedDrawRule(def);
    const policy=resolvedRunPolicy(def);
    if(rule.winnerCount<0||rule.winnerCount>64){
      warnings.push("당첨자 수 권장 범위는 0~64입니다.");
    }
    if(policy.timeoutSeconds<0||policy.timeoutSeconds>1800){
      warnings.push("제한 시간 권장 범위는 0~1800초입니다.");
    }
    if(policy.qualificationMinWinners<0||policy.qualificationMinWinners>64){
      warnings.push("최소 당첨 인원 권장 범위는 0~64입니다.");
    }
    if(policy.qualificationMaxNudges<0||policy.qualificationMaxNudges>1000){
      warnings.push("최대 보정 횟수 권장 범위는 0~1000입니다.");
    }
    const comps=Array.isArray(def?.components)?def.components:[];
    if(comps.length>500){
      warnings.push("컴포넌트가 500개를 초과했습니다. 성능 저하 가능성이 있습니다.");
    }
    const warnRange=(prefix,p,key,min,max,label)=>{
      if(p[key]===undefined) return;
      const value=Number(p[key]);
      if(Number.isFinite(value)&&(value<min||value>max)){
        warnings.push(prefix+": "+label+" 권장 범위 "+min+"~"+max+" 밖입니다.");
      }
    };
    for(const c of comps){
      const p=c?.properties||{};
      const prefix=(c?.type||"COMPONENT")+" "+String(c?.id||"").slice(0,8);
      const x=Number(c?.x),y=Number(c?.y);
      if(Number.isFinite(x)&&Number.isFinite(y)&&Number.isFinite(w)&&Number.isFinite(h)&&(x<0||x>w||y<0||y>h)){
        warnings.push(prefix+": 기준점이 World 밖에 있습니다.");
      }
      warnRange(prefix,p,"restitution",0,1.4,"탄성");
      warnRange(prefix,p,"friction",0,.5,"마찰");
      if(c?.type==="ROTATIONAL_BODY"){
        warnRange(prefix,p,"angularSpeed",-720,720,"회전 속도");
        warnRange(prefix,p,"period",.25,30,"회전 주기");
        warnRange(prefix,p,"pivotRatio",-1,1,"피벗 위치");
        warnRange(prefix,p,"motorTorque",0,200,"회전 토크");
        warnRange(prefix,p,"jointFriction",0,50,"관절 마찰");
      }
      warnRange(prefix,p,"burstPowerVariance",0,.75,"버스트 세기 편차");
      warnRange(prefix,p,"burstIntervalMs",0,5000,"버스트 간격");
      warnRange(prefix,p,"beltSpeed",-1200,1200,"벨트 속도");
      warnRange(prefix,p,"beltGrip",0,1,"벨트 마찰 전달");
      if(c?.type==="BURST_SPAWN"){
        const min=Number(p.burstSizeMin),max=Number(p.burstSizeMax);
        if(Number.isFinite(min)&&Number.isFinite(max)&&(min<1||max<1||min>32||max>32||min>max)){
          warnings.push(prefix+": 버스트 묶음 크기 권장값은 1~32이며 최소≤최대입니다.");
        }
      }
      if(c?.type==="ELEVATOR"){
        const min=Number(p.travelMin),max=Number(p.travelMax);
        if(Number.isFinite(min)&&Number.isFinite(max)&&min>=max){
          warnings.push(prefix+": 엘리베이터 이동 시작/종료 위치가 뒤집히거나 같습니다.");
        }
      }
      if(c?.type==="OUTPUT"){
        if(String(p.outputKey||"").length>32) warnings.push(prefix+": 출력 키가 32자를 초과합니다.");
        const rank=Number(p.outputRank),capacity=Number(p.outputCapacity),weight=Number(p.outputWeight);
        if(Number.isFinite(rank)&&(rank<1||rank>64)) warnings.push(prefix+": 출력 순위 권장 범위는 1~64입니다.");
        if(Number.isFinite(capacity)&&(capacity<1||capacity>64)) warnings.push(prefix+": 출력 용량 권장 범위는 1~64입니다.");
        if(Number.isFinite(weight)&&(weight<=0||weight>100)) warnings.push(prefix+": 출력 가중치 권장 범위는 0 초과~100입니다.");
      }
      if(c?.type==="SLOT"){
        const capacity=Number(p.slotCapacity);
        if(Number.isFinite(capacity)&&(capacity<1||capacity>64)) warnings.push(prefix+": 슬롯 용량 권장 범위는 1~64입니다.");
      }
    }
    return warnings;
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
      this.resetRotationStates();
    }

    resetRotationStates(){
      this.rotationStates=new Map();
      for(const component of this.definition.components){
        if(component.type!=="ROTATIONAL_BODY") continue;
        const mode=rotationMode(component);
        if(mode.startsWith("FORCE_")) continue;
        const speed=finiteOr(component.properties?.angularSpeed,0);
        this.rotationStates.set(component.id,{
          angle:rotationInitialAngle(component),
          angularVelocity:mode==="TORQUE_CONTINUOUS" ? speed : 0,
          direction:speed<0 ? -1 : 1
        });
      }
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
      this.resetRotationStates();

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
        const r=Math.max(
          .001,
          Math.abs(Number(spawn.properties?.marbleRadius)||11)
        );
        const localIndex=Math.floor(i/spawns.length);
        const angle=(localIndex*2.399963229728653)+(rng()-.5)*.2;
        const burstSpawn=spawn.type==="BURST_SPAWN";
        const spread=burstSpawn
          ? Math.min(
              22,
              Math.sqrt((localIndex%9)+1)*r*.55
            )
          : Math.sqrt(localIndex+1)*Math.min(r*1.35,16);
        const spreadYScale=burstSpawn ? .45 : 1;
        let vx=(rng()-.5)*35;
        let vy=(rng()-.5)*8;
        if(burstSpawn){
          const jitter=(rng()*2-1)*finiteOr(spawn.properties?.burstSpreadDegrees,24);
          const direction=degToRad(finiteOr(spawn.properties?.burstDirectionDegrees,-90)+jitter);
          const variance=finiteOr(spawn.properties?.burstPowerVariance,.22);
          const power=finiteOr(spawn.properties?.burstPower,1.15)
            *(1+(rng()*2-1)*variance);
          vx=Math.cos(direction)*power*145;
          vy=Math.sin(direction)*power*145;
        }
        this.marbles.push({
          id:"m"+(i+1),
          x:spawn.x+Math.cos(angle)*spread,
          y:spawn.y+Math.sin(angle)*spread*spreadYScale,
          vx,
          vy,
          radius:r,
          finished:false,
          eliminated:false,
          dnf:false,
          rank:0,
          finishTime:null,
          boostContacts:new Set(),
          oneWayPassThrough:new Set()
        });
      }
      return this.snapshot();
    }

    effectiveTargetCount(){
      const target=targetCountForDefinition(this.definition);
      return Number.isFinite(target)
        ? target
        : this.marbles.length;
    }

    isComplete(){
      const target=this.effectiveTargetCount();
      return target>0 && this.finishOrder.length>=target;
    }

    advance(realDt){
      if(this.isComplete()) return this.snapshot();
      this.accumulator+=clamp(Number(realDt)||0,0,.05);
      let guard=0;
      while(this.accumulator>=this.fixedDt && guard<12){
        this.step(this.fixedDt);
        this.accumulator-=this.fixedDt;
        guard++;
        if(this.isComplete()){
          this.accumulator=0;
          break;
        }
      }
      return this.snapshot();
    }

    rotationShapes(component){
      const mode=rotationMode(component);
      if(mode.startsWith("FORCE_")){
        return componentShapes(component,this.time);
      }

      const state=this.rotationStates.get(component.id);
      if(!state) return componentShapes(component,this.time);

      const bladeCount=Math.max(
        1,
        Math.min(
          4,
          Math.trunc(finiteOr(component.properties?.bladeCount,1))
        )
      );
      return Array.from(
        {length:bladeCount},
        (_,index)=>pivotedComponentShape(
          component,
          state.angle+(180/bladeCount)*index
        )
      );
    }

    updateRotationStates(dt){
      const world=this.definition.world;
      const gravityX=finiteOr(world.gravityX,0)*80;
      const gravityY=finiteOr(world.gravityY,12)*80;

      for(const component of this.definition.components){
        if(component.type!=="ROTATIONAL_BODY") continue;
        const mode=rotationMode(component);
        if(mode.startsWith("FORCE_")) continue;

        const state=this.rotationStates.get(component.id);
        if(!state) continue;

        const p=component.properties||{};
        const shape=pivotedComponentShape(component,state.angle);
        const pivot=componentPivotWorld(component);
        const rx=shape.x-pivot.x;
        const ry=shape.y-pivot.y;
        const radiusSq=Math.max(400,rx*rx+ry*ry);
        const gravityTorque=rx*gravityY-ry*gravityX;
        state.angularVelocity+=
          (gravityTorque/radiusSq)*(180/Math.PI)*dt;

        const friction=Math.max(0,finiteOr(p.jointFriction,.15));
        state.angularVelocity*=Math.exp(-friction*dt*2.5);

        const speed=finiteOr(p.angularSpeed,90);
        const torque=Math.max(0,finiteOr(p.motorTorque,30));

        if(mode==="TORQUE_CONTINUOUS"){
          const maxDelta=torque*12*dt;
          state.angularVelocity+=clamp(
            speed-state.angularVelocity,
            -maxDelta,
            maxDelta
          );
        }else if(mode==="TORQUE_OSCILLATE"){
          const limits=rotationLimitRange(component);
          const minAngle=limits.min;
          const maxAngle=limits.max;

          if(state.angle<=minAngle+.25) state.direction=1;
          if(state.angle>=maxAngle-.25) state.direction=-1;

          const target=Math.abs(speed)*state.direction;
          const maxDelta=torque*12*dt;
          state.angularVelocity+=clamp(
            target-state.angularVelocity,
            -maxDelta,
            maxDelta
          );
        }

        state.angle+=state.angularVelocity*dt;

        if(mode==="FREE"||mode==="TORQUE_OSCILLATE"){
          const limits=rotationLimitRange(component);
          const minAngle=limits.min;
          const maxAngle=limits.max;

          if(state.angle<minAngle){
            state.angle=minAngle;
            if(state.angularVelocity<0) state.angularVelocity*=0;
            state.direction=1;
          }else if(state.angle>maxAngle){
            state.angle=maxAngle;
            if(state.angularVelocity>0) state.angularVelocity*=0;
            state.direction=-1;
          }
        }
      }
    }

    applyRotationImpact(component,contact){
      const mode=rotationMode(component);
      if(mode.startsWith("FORCE_")) return;

      const state=this.rotationStates.get(component.id);
      if(!state||!contact) return;

      const pivot=componentPivotWorld(component);
      const rx=contact.contactX-pivot.x;
      const ry=contact.contactY-pivot.y;
      const radius=Math.hypot(rx,ry);
      if(radius<8) return;

      const tx=-ry/radius;
      const ty=rx/radius;
      const tangentSpeed=
        contact.incomingVx*tx+contact.incomingVy*ty;
      const deltaDegrees=
        (tangentSpeed/radius)*(180/Math.PI)*.45;

      if(Number.isFinite(deltaDegrees)){
        state.angularVelocity+=deltaDegrees;
      }
    }

    collisionStepSeconds(remaining){
      let maxSpeed=0;
      let minRadius=Infinity;
      for(const marble of this.marbles){
        if(marble.finished||marble.eliminated||marble.dnf) continue;
        maxSpeed=Math.max(
          maxSpeed,
          Math.hypot(marble.vx,marble.vy)
        );
        minRadius=Math.min(
          minRadius,
          Math.max(1,finiteOr(marble.radius,11))
        );
      }
      if(maxSpeed<1e-6||!Number.isFinite(minRadius)){
        return remaining;
      }
      const maxTravel=clamp(minRadius*.75,4,12);
      return Math.min(
        remaining,
        Math.max(
          1/2400,
          maxTravel/maxSpeed
        )
      );
    }

    step(dt){
      if(this.isComplete()) return;
      let remaining=Math.max(0,finiteOr(dt,0));
      let guard=0;
      while(remaining>1e-9&&guard<24){
        const subDt=this.collisionStepSeconds(remaining);
        this.stepPhysics(subDt);
        remaining-=subDt;
        guard+=1;
        if(this.isComplete()){
          remaining=0;
          break;
        }
      }
      if(remaining>1e-9&&!this.isComplete()){
        this.stepPhysics(remaining);
      }
    }

    stepPhysics(dt){
      if(this.isComplete()) return;
      const world=this.definition.world;
      const gravityScale=80;
      this.time+=dt;
      this.updateRotationStates(dt);
      const damping=Math.pow(
        .9995,
        dt/this.fixedDt
      );

      for(const m of this.marbles){
        if(m.finished||m.eliminated||m.dnf) continue;
        m.vx+=world.gravityX*gravityScale*dt;
        m.vy+=world.gravityY*gravityScale*dt;
        m.vx*=damping;
        m.vy*=damping;
        const prevX=m.x,prevY=m.y;
        m.x+=m.vx*dt;
        m.y+=m.vy*dt;

        this.resolveWorldBounds(m,world);
        const nextBoostContacts=new Set();
        for(const c of this.definition.components){
          const shapes=c.type==="ROTATIONAL_BODY"
            ? this.rotationShapes(c)
            : componentShapes(c,this.time);
          for(let shapeIndex=0;shapeIndex<shapes.length;shapeIndex++){
            const shape=shapes[shapeIndex];
            if(isRectCollider(c)){
              const contact=isOneWayCollider(c)
                ? this.resolveOneWayRect(
                    m,
                    shape,
                    prevX,
                    prevY,
                    nextBoostContacts,
                    this.colliderPointVelocity(
                      c,
                      m.x,
                      m.y
                    ),
                    c.id+":"+shapeIndex
                  )
                : this.resolveRect(
                    m,
                    shape,
                    nextBoostContacts
                  );
              if(c.type==="ROTATIONAL_BODY"&&contact){
                this.applyRotationImpact(c,contact);
              }
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
        const target=this.effectiveTargetCount();
        for(const m of active){
          if(this.finishOrder.length>=target) break;
          const output=outputs.find(o=>
            !this.outputClaims.has(Math.trunc(finiteOr(o.properties?.outputRank,0)))
            && Math.trunc(finiteOr(o.properties?.outputRank,0))<=target
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
        const zones=this.definition.components.filter(c=>c.type==="FINISH");
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
      const target=this.effectiveTargetCount();
      for(const m of active){
        if(this.finishOrder.length>=target) break;
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

    colliderPointVelocity(component,x,y){
      if(component?.type==="ELEVATOR"){
        const now=elevatorPosition(component,this.time);
        const next=elevatorPosition(
          component,
          this.time+this.fixedDt
        );
        return {
          x:(next.x-now.x)/this.fixedDt,
          y:(next.y-now.y)/this.fixedDt
        };
      }
      if(component?.type!=="ROTATIONAL_BODY"){
        return {x:0,y:0};
      }

      const mode=rotationMode(component);
      let angularVelocity=0;
      if(mode.startsWith("FORCE_")){
        const now=motionRotation(component,this.time);
        const next=motionRotation(
          component,
          this.time+this.fixedDt
        );
        angularVelocity=(next-now)/this.fixedDt;
      }else{
        angularVelocity=finiteOr(
          this.rotationStates.get(component.id)
            ?.angularVelocity,
          0
        );
      }

      const pivot=componentPivotWorld(component);
      const omega=degToRad(angularVelocity);
      const rx=x-pivot.x;
      const ry=y-pivot.y;
      return {
        x:-omega*ry,
        y:omega*rx
      };
    }

    resolveOneWayRect(
      m,
      c,
      prevX,
      prevY,
      nextBoostContacts=null,
      surfaceVelocity={x:0,y:0},
      latchKey=c.id
    ){
      const direction=oneWayDirection(c);
      const angle=degToRad(c.rotation||0);
      const co=Math.cos(angle),si=Math.sin(angle);
      const toLocal=(x,y)=>{
        const dx=x-c.x,dy=y-c.y;
        return {
          x:dx*co+dy*si,
          y:-dx*si+dy*co
        };
      };
      const previous=toLocal(prevX,prevY);
      const current=toLocal(m.x,m.y);
      const hw=Math.max(.001,Math.abs(c.width)/2);
      const hh=Math.max(.001,Math.abs(c.height)/2);
      const surface=hh+m.radius;
      const prevDepth=previous.y*direction;
      const currDepth=current.y*direction;
      const relativeVx=
        m.vx-finiteOr(surfaceVelocity?.x,0);
      const relativeVy=
        m.vy-finiteOr(surfaceVelocity?.y,0);
      const localVy=
        (-relativeVx*si+relativeVy*co)*direction;
      const key=latchKey;
      m.oneWayPassThrough ||= new Set();

      if(m.oneWayPassThrough.has(key)){
        if(
          currDepth>=surface+.5
          || currDepth<=-surface-.5
        ){
          m.oneWayPassThrough.delete(key);
        }
        return null;
      }

      if(
        localVy>0
        && prevDepth<=-surface
        && currDepth>-surface
      ){
        m.oneWayPassThrough.add(key);
        return null;
      }

      if(
        localVy>=0
        || prevDepth<surface
        || currDepth>=surface
      ){
        return null;
      }

      const denom=prevDepth-currDepth;
      const t=Math.abs(denom)>1e-9
        ? clamp((prevDepth-surface)/denom,0,1)
        : 0;
      const hitX=previous.x+(current.x-previous.x)*t;
      if(Math.abs(hitX)>hw+m.radius) return null;

      const correctedY=direction*(surface+.25);
      const correctedX=current.x;
      m.x=c.x+correctedX*co-correctedY*si;
      m.y=c.y+correctedX*si+correctedY*co;

      const nx=-si*direction;
      const ny=co*direction;
      let rvx=relativeVx;
      let rvy=relativeVy;
      const vn=rvx*nx+rvy*ny;
      if(vn<0){
        const restitution=finiteOr(
          c.properties?.restitution,
          .35
        );
        rvx-=(1+restitution)*vn*nx;
        rvy-=(1+restitution)*vn*ny;
        const friction=finiteOr(
          c.properties?.friction,
          .05
        );
        const tx=-ny,ty=nx;
        const vt=rvx*tx+rvy*ty;
        rvx-=vt*friction*tx;
        rvy-=vt*friction*ty;
        m.vx=rvx+finiteOr(surfaceVelocity?.x,0);
        m.vy=rvy+finiteOr(surfaceVelocity?.y,0);
      }

      const boost=finiteOr(c.properties?.boost,0);
      if(boost!==0&&nextBoostContacts){
        nextBoostContacts.add(c.id);
        if(!m.boostContacts?.has(c.id)){
          m.vx+=nx*boost*70;
          m.vy+=ny*boost*70;
        }
      }

      return {
        contactX:c.x+hitX*co-direction*hh*si,
        contactY:c.y+hitX*si+direction*hh*co,
        normalX:nx,
        normalY:ny,
        incomingVx:m.vx,
        incomingVy:m.vy
      };
    }

    resolveRect(m,c,nextBoostContacts=null){
      const incomingVx=m.vx;
      const incomingVy=m.vy;
      const a=degToRad(c.rotation||0),co=Math.cos(a),si=Math.sin(a);
      const dx=m.x-c.x,dy=m.y-c.y;
      const lx=dx*co+dy*si, ly=-dx*si+dy*co;
      const hw=Math.max(.001,Math.abs(c.width)/2),hh=Math.max(.001,Math.abs(c.height)/2);
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
      if(penetration<=0) return null;

      const contactX=c.x+qx*co-qy*si;
      const contactY=c.y+qx*si+qy*co;
      const wx=nx*co-ny*si, wy=nx*si+ny*co;
      m.x+=wx*penetration;
      m.y+=wy*penetration;
      const vn=m.vx*wx+m.vy*wy;
      if(vn<0){
        const restitution=finiteOr(c.properties?.restitution,.35);
        m.vx-=(1+restitution)*vn*wx;
        m.vy-=(1+restitution)*vn*wy;
        const friction=finiteOr(c.properties?.friction,.05);
        const tx=-wy,ty=wx,vt=m.vx*tx+m.vy*ty;
        m.vx-=vt*friction*tx;
        m.vy-=vt*friction*ty;
      }
      const boost=finiteOr(c.properties?.boost,0);
      if(boost!==0&&nextBoostContacts){
        nextBoostContacts.add(c.id);
        if(!m.boostContacts?.has(c.id)){
          m.vx+=wx*boost*70;
          m.vy+=wy*boost*70;
        }
      }
      return {
        contactX,
        contactY,
        normalX:wx,
        normalY:wy,
        incomingVx,
        incomingVy
      };
    }

    resolveCircle(m,c,nextBoostContacts=null){
      let dx=m.x-c.x,dy=m.y-c.y;
      let dist=Math.hypot(dx,dy);
      const target=m.radius+Math.max(.001,Math.abs(c.radius));
      if(dist>=target) return;
      if(dist<1e-8){dx=1;dy=0;dist=1;}
      const nx=dx/dist,ny=dy/dist;
      const penetration=target-dist;
      m.x+=nx*penetration;
      m.y+=ny*penetration;
      const vn=m.vx*nx+m.vy*ny;
      if(vn<0){
        const restitution=finiteOr(c.properties?.restitution,.55);
        m.vx-=(1+restitution)*vn*nx;
        m.vy-=(1+restitution)*vn*ny;
      }
      const boost=finiteOr(c.properties?.boost,0);
      if(boost!==0&&nextBoostContacts){
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
          const target=finiteOr(conveyor.properties?.beltSpeed,160);
          const grip=finiteOr(conveyor.properties?.beltGrip,.22);
          const current=m.vx*tx+m.vy*ty;
          const change=(target-current)*grip;
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
          : this.isComplete()
            ? "COMPLETED"
            : "RUNNING",
        selectedOutputKey:this.selectedOutputKey,
        finishedCount:this.finishOrder.length,
        targetCount:this.effectiveTargetCount(),
        completionTime:this.isComplete() ? this.time : null,
        winnerSplits:this.finishOrder.map((id,index)=>{
          const marble=this.marbles.find(candidate=>candidate.id===id);
          return {
            rank:marble?.rank||index+1,
            id,
            time:marble?.finishTime??null
          };
        }),
        totalCount:this.marbles.length,
        components:[...this.rotationStates.entries()].map(
          ([id,state])=>{
            const component=this.definition.components.find(
              candidate=>candidate.id===id
            );
            const shape=component
              ? pivotedComponentShape(component,state.angle)
              : null;
            return {
              id,
              type:"ROTATIONAL_BODY",
              x:shape?.x ?? 0,
              y:shape?.y ?? 0,
              runtimeRotation:state.angle,
              angularVelocity:state.angularVelocity
            };
          }
        )     };
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
    isDirectionalCollider,
    colliderCollisionMode,
    wallCollisionMode,
    oneWayDirection,
    isOneWayCollider,
    isOneWayWall,
    defaultVisualStyle,
    componentVisualStyle,
    defaultDefinition,
    emptyDefinition,
    validateDefinition,
    validateWarnings,
    componentShapes,
    componentPivotLocal,
    componentPivotWorld,
    pivotedComponentShape,
    rotationMode,
    rotationLimitRange,
    rotationInitialAngle,
    motionRotation,
    resolvedDrawRule,
    resolvedRunPolicy,
    targetCountForDefinition,
    conditionalOutputActive,
    elevatorPosition,
    PreviewEngine
  };
})(globalThis);
