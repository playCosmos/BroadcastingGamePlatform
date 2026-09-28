(() => {
  "use strict";

  class NumberReelPresentation {
    constructor(canvas, resultRoot) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.resultRoot = resultRoot;
      this.frame = 0;
      this.running = false;
      this.values = [];
      this.max = 45;
      this.startedAt = 0;
      this.duration = 2300;
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      return { dpr, width: rect.width, height: rect.height };
    }

    displayNumber(value) {
      const width = Math.max(1, String(this.max).length);
      return String(value).padStart(width, "0");
    }

    fakeValue(reel, step) {
      let x = Math.imul(step + 17, 0x45d9f3b) ^ Math.imul(reel + 31, 0x27d4eb2d);
      x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
      x ^= x >>> 16;
      return (Math.abs(x) % this.max) + 1;
    }

    draw(now) {
      const { dpr, width:w, height:h } = this.resize();
      const ctx = this.ctx;
      ctx.setTransform(dpr,0,0,dpr,0,0);
      ctx.clearRect(0,0,w,h);
      ctx.fillStyle = "#12080a";
      ctx.fillRect(0,0,w,h);

      const count = Math.max(1,this.values.length || 7);
      const slot = (w * .96) / count;
      const left = (w - slot * count) / 2;
      const faceW = slot * .88;
      const faceH = h * .72;
      const progress = this.running ? Math.min(1,(now-this.startedAt)/this.duration) : 1;
      const eased = 1-Math.pow(1-progress,5);

      for(let i=0;i<count;i++){
        const cx = left + slot*(i+.5);
        const target = this.values[i];
        let visible = target;
        if(this.running && progress < 1){
          const step = Math.floor((1-eased)*70 + i*11 + now/55);
          visible = this.fakeValue(i,step);
        }
        const x=cx-faceW/2,y=(h-faceH)/2,r=Math.min(14,faceW*.12);
        ctx.beginPath();
        ctx.roundRect(x,y,faceW,faceH,r);
        const g=ctx.createLinearGradient(0,y,0,y+faceH);
        g.addColorStop(0,"#fffdf7");g.addColorStop(.5,"#f7ead9");g.addColorStop(1,"#d9bca7");
        ctx.fillStyle=g;ctx.fill();
        ctx.strokeStyle="rgba(116,66,47,.45)";ctx.lineWidth=1.5;ctx.stroke();
        ctx.fillStyle="#6d281c";
        ctx.font=`900 ${Math.min(faceH*.43,faceW*.55)}px ui-monospace,monospace`;
        ctx.textAlign="center";ctx.textBaseline="middle";
        ctx.fillText(visible == null ? "—" : this.displayNumber(visible),cx,h/2);
      }

      if(this.running && progress < 1){
        this.frame=requestAnimationFrame((time)=>this.draw(time));
      }else{
        this.running=false;
        this.renderResult();
      }
    }

    renderResult(){
      this.resultRoot.replaceChildren();
      for(const value of this.values){
        const pill=document.createElement("span");
        pill.className="number-pill";
        pill.textContent=this.displayNumber(value);
        this.resultRoot.appendChild(pill);
      }
    }

    play(values,max){
      cancelAnimationFrame(this.frame);
      this.values=values.slice();
      this.max=max;
      this.startedAt=performance.now();
      this.running=true;
      this.draw(this.startedAt);
    }

    clear(count=7,max=45){
      cancelAnimationFrame(this.frame);
      this.running=false;
      this.values=Array.from({length:count},()=>null);
      this.max=max;
      this.draw(performance.now());
      this.resultRoot.replaceChildren();
    }
  }

  window.ViewerDrawNumberPresentation = NumberReelPresentation;
})();