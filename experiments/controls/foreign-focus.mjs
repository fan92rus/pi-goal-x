/** A separate extension for the installed Pi keyboard-ownership walkthrough. */
export default function foreignFocus(pi) {
 pi.registerCommand('foreign-focus', {
  description:'Open a foreign focus fixture',
  handler:async(mode,ctx)=>{
   if(mode==='native') {await ctx.ui.select('Foreign native dialog owns keyboard',['Close with Escape']); return;}
   await ctx.ui.custom((_tui,_theme,_keys,done)=>({
    render:()=>['Foreign overlay owns keyboard','Close with Escape'],
    getText:()=>'',setText(){},
    handleInput:data=>{if(data==='\x1b')done(undefined);},
   }),{overlay:true,overlayOptions:{anchor:'center',width:60}});
  },
 });
}
