import { listen } from "@tauri-apps/api/event";
import { FRAME, px, cpx, bodyDepth, shapeLength, notchPath, notchTransform, isVertical, type Edge } from "./layout";
import { Spring } from "./motion";
import { call, native } from "./task-client";

const box = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; };
const lerp = (a:number,b:number,t:number) => a+(b-a)*t;

/** The task sibling uses the same pill geometry, scale and spring as usage. */
export class TaskSurface {
  edge: Edge = "left";
  open = false;
  pinned = false;
  editing = false;
  private hovering = false;
  private suppressed = false;
  private timer = 0;
  private frame = 0;
  private last = 0;
  private fold = new Spring(0, .42, .78);
  private reduced = matchMedia("(prefers-reduced-motion: reduce)");
  private shell = document.getElementById("notch-shell")!;
  private panel = document.getElementById("task-panel")!;
  private rail = document.getElementById("task-rail")!;
  private shape = document.getElementById("rail-shape")!;
  private ring = document.getElementById("focus-ring")!;
  private height = cpx(FRAME.taskPanelMinHeight);
  private gap = cpx(FRAME.tailGap);
  private panelWidth = cpx(FRAME.taskPanelWidth);
  private masks: {x:number;y:number;width:number;height:number}[] = [];

  constructor() {
    document.documentElement.style.setProperty("--task-indent",`${cpx(FRAME.taskIndent)}px`);
    document.documentElement.style.setProperty("--row-height",`${cpx(FRAME.taskRowHeight)}px`);
    this.panel.style.width = `${this.panelWidth}px`;
    window.addEventListener("resize",()=>this.measure());
    this.reduced.addEventListener("change",()=>{this.fold.snap(this.open?1:0);this.paint();});
  }

  async boot() {
    if(native) {
      await listen<{hover:boolean}>("tasks:hover", e=>this.hover(e.payload.hover));
      await listen<{edge:Edge}>("tasks:placement", e=>{void this.place(e.payload.edge);});
    } else {
      document.body.classList.add("preview");
      document.addEventListener("pointermove", e=>this.hover(this.masks.some(r=>e.clientX>=r.x && e.clientX<r.x+r.width && e.clientY>=r.y && e.clientY<r.y+r.height)));
      document.documentElement.addEventListener("pointerleave",()=>this.hover(false));
    }
    await this.place((await call<{edge:Edge}>("get_task_placement")).edge);
  }

  async place(edge:Edge) {
    this.edge = edge;
    this.shell.dataset.edge = edge;
    document.querySelectorAll<HTMLElement>("[data-task-edge]").forEach(b=>b.setAttribute("aria-pressed",String(b.dataset.taskEdge===edge)));
    const vertical=isVertical(edge), depth=px(bodyDepth(edge));
    const size={width:vertical?this.panelWidth+this.gap+depth:this.panelWidth,
      height:cpx(FRAME.taskPanelHeight)+(vertical?0:this.gap+depth)};
    this.shell.style.width=`${size.width}px`;
    this.shell.style.height=`${size.height}px`;
    if(native) {
      await call("set_notch_size",size);
      this.shell.style.height=`${window.innerHeight}px`;
    }
    this.measure();
  }

  measure() {
    if(native) this.shell.style.height=`${window.innerHeight}px`;
    const content=document.getElementById("task-list-content")!;
    const chrome=[...this.panel.children].filter(el=>el.id!=="task-list").reduce((n,el)=>n+(el as HTMLElement).offsetHeight,0);
    const available=this.shell.clientHeight-(isVertical(this.edge)?0:px(bodyDepth(this.edge))+this.gap);
    this.height=Math.min(available,cpx(FRAME.taskPanelHeight),Math.max(cpx(FRAME.taskPanelMinHeight),chrome+content.offsetHeight+cpx(FRAME.cardPadding)));
    this.panel.style.height=`${this.height}px`;
    this.paint();
  }

  hover(value:boolean) {
    this.hovering=value;
    clearTimeout(this.timer);
    if(!value) {this.suppressed=false;this.timer=window.setTimeout(()=>this.show(false),450);}
    else if(!this.suppressed) this.show(true);
  }

  show(value:boolean) {
    if(!value && (this.pinned || this.editing)) return;
    if(this.open===value) return;
    this.open=value;
    this.panel.inert=!value;
    this.shell.classList.toggle("is-open",value);
    this.ring.setAttribute("aria-expanded",String(value));
    this.fold.setTarget(value?1:0);
    if(this.reduced.matches) {this.fold.snap(value?1:0);this.paint();return;}
    if(!this.frame) {this.last=0;this.frame=requestAnimationFrame(t=>this.tick(t));}
    this.report();
  }

  pin() {
    this.pinned=!this.pinned;
    document.getElementById("pin")!.setAttribute("aria-pressed",String(this.pinned));
    if(this.pinned) this.show(true); else if(!this.hovering) this.show(false);
  }

  async input(active:boolean) {
    await call("set_task_input",{active});
    this.editing=active;
    if(active) this.show(true);
    else if(!this.hovering) this.hover(false);
  }

  async collapse() {
    await this.input(false);
    this.pinned=false;
    document.getElementById("pin")!.setAttribute("aria-pressed","false");
    this.suppressed=true;
    this.show(false);
  }

  private tick(now:number) {
    this.fold.step(this.last?Math.min((now-this.last)/1000,.05):.016);
    this.last=now;
    this.paint();
    if(!this.fold.settled) this.frame=requestAnimationFrame(t=>this.tick(t));
    else {this.fold.snap(this.open?1:0);this.frame=0;this.paint();}
  }

  private paint() {
    const t=Math.max(0,Math.min(1.02,this.fold.value)), visible=Math.min(1,t);
    const vertical=isVertical(this.edge), sw=this.shell.clientWidth, sh=this.shell.clientHeight;
    const d=lerp(FRAME.pillThin,bodyDepth(this.edge),t), l=lerp(FRAME.pillLong,shapeLength(1,this.edge),t);
    const depth=px(d), length=px(l), hot=Math.max(depth,px(FRAME.pillHotZone));
    const rw=vertical?hot:length,rh=vertical?length:hot;
    const rx=vertical?(this.edge==="left"?0:sw-rw):(sw-rw)/2;
    const ry=vertical?(sh-rh)/2:(this.edge==="top"?0:sh-rh);
    Object.assign(this.rail.style,{left:`${rx}px`,top:`${ry}px`,width:`${rw}px`,height:`${rh}px`});
    const svgW=vertical?depth:length,svgH=vertical?length:depth;
    Object.assign(this.shape.style,{width:`${svgW}px`,height:`${svgH}px`,left:this.edge==="right"?`${rw-svgW}px`:"0px",top:this.edge==="bottom"?`${rh-svgH}px`:"0px"});
    this.shape.setAttribute("viewBox",`0 0 ${vertical?d:l} ${vertical?l:d}`);
    const path=this.shape.querySelector("path")!;
    path.setAttribute("d",notchPath(d,l,lerp(FRAME.pillThin/2,FRAME.curlRadius,t)));
    path.setAttribute("transform",notchTransform(this.edge,d));
    this.ring.style.opacity=String(Math.max(0,(visible-.35)/.65));
    const expanded=px(bodyDepth(this.edge));
    const panelX=vertical?(this.edge==="left"?expanded+this.gap:0):(sw-this.panelWidth)/2;
    const panelY=vertical?(sh-this.height)/2:(this.edge==="top"?expanded+this.gap:sh-expanded-this.gap-this.height);
    const slide=(1-t)*cpx(FRAME.taskPanelSlide);
    Object.assign(this.panel.style,{left:`${panelX}px`,top:`${panelY}px`,opacity:String(visible),visibility:t>0?"visible":"hidden",
      transform:`translate(${vertical?(this.edge==="left"?-slide:slide):0}px,${vertical?0:(this.edge==="top"?-slide:slide)}px) scale(${.98+.02*t})`,
      transformOrigin:this.edge==="left"?"left center":this.edge==="right"?"right center":this.edge==="top"?"center top":"center bottom"});
    this.report();
  }

  private report() {
    const r=box(this.rail);
    this.masks=[r];
    if(this.open) {
      const p=box(this.panel), pad=this.gap/2;
      this.masks.push({x:p.x-pad,y:p.y-pad,width:p.width+2*pad,height:p.height+2*pad});
      // Bridge the gap while the pill is still expanding, including spring travel.
      if(isVertical(this.edge)) this.masks.push({x:Math.min(r.x,p.x),y:r.y,width:Math.max(r.x+r.width,p.x+p.width)-Math.min(r.x,p.x),height:r.height});
      else this.masks.push({x:r.x,y:Math.min(r.y,p.y),width:r.width,height:Math.max(r.y+r.height,p.y+p.height)-Math.min(r.y,p.y)});
    }
    const origin=box(this.shell);
    if(native) void call("set_interactive_rects",{rects:this.masks.map(r=>({...r,x:r.x-origin.x,y:r.y-origin.y}))}).catch(()=>{});
  }
}
