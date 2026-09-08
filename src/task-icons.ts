import { PauseIcon, PlayIcon, StopIcon, Tick02Icon, ListViewIcon, PinIcon, Settings01Icon, Cancel01Icon, ArrowDown01Icon, PlusSignIcon, FocusIcon } from "@hugeicons/core-free-icons";
const icons={pause:PauseIcon,play:PlayIcon,stop:StopIcon,check:Tick02Icon,list:ListViewIcon,pin:PinIcon,settings:Settings01Icon,close:Cancel01Icon,down:ArrowDown01Icon,plus:PlusSignIcon,focus:FocusIcon};
export type TaskIcon=keyof typeof icons;
/** Render Hugeicons' static SVG data without introducing a UI framework. */
export function taskIcon(name:TaskIcon) {
  const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");
  for(const [key,value] of Object.entries({viewBox:"0 0 24 24",fill:"none",width:"20",height:"20","aria-hidden":"true",focusable:"false","stroke-linecap":"round","stroke-linejoin":"round"})) svg.setAttribute(key,value);
  for(const [tag,attributes] of icons[name]) {
    const child=document.createElementNS(svg.namespaceURI,tag);
    for(const [key,value] of Object.entries(attributes)) if(key!=="key") child.setAttribute(key.replace(/[A-Z]/g,c=>"-"+c.toLowerCase()),String(value));
    svg.append(child);
  }
  return svg;
}
export function paintIcon(target:HTMLElement,name:TaskIcon) {
  if(target.dataset.icon===name)return;
  target.replaceChildren(taskIcon(name));target.dataset.icon=name;
}
