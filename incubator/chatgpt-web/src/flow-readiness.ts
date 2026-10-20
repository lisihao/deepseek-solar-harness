import type { StudioGraph, StudioIssue } from '@lisihao/dsh-solar-native-collaboration/studio-contracts'
import type { GeminiSemanticSelectors } from './gemini-port.js'

/** Known missing configuration stops the whole flow before a paid predecessor. */
export function flowReadiness(graph: StudioGraph): readonly StudioIssue[] {
  const semantics=graph.parameters.geminiSemantics as GeminiSemanticSelectors|undefined
  const issues:StudioIssue[]=[]
  for(const node of graph.nodes) {
    if(node.kind!=='gemini-research'&&node.kind!=='gemini-thinking') continue
    const missing:string[]=[]
    if(!semantics?.submitSelector)missing.push('发送按钮')
    if(!semantics?.promptReceiptSelector)missing.push('原问题回执')
    if(node.kind==='gemini-research') {
      if(!semantics?.planReadyMarker)missing.push('研究计划完成标志')
      if(!semantics?.researchStartSelector)missing.push('研究启动按钮')
      if(!semantics?.researchReportReadyMarker)missing.push('研究报告完成标志')
    }
    const requested=node.parameters.requested as {effortLabel?:string}|undefined
    if(requested?.effortLabel&&(!semantics?.thinking?.triggerSelector||!semantics.thinking.optionSelector||!semantics.thinking.selectedSelector)) missing.push('思考等级选择与回读')
    if(missing.length)issues.push({nodeId:node.id,message:`${node.label} 的网页适配尚未通过验收，缺少已核实的${missing.join('、')}。本次不会启动前序模型调用；需要由插件维护者完成适配验收。`})
  }
  return issues
}
