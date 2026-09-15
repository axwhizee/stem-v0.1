// ============================================================
// core/tools/internal/systemTools.ts —— internal 系统工具聚合
// ============================================================

import type { ToolCapability } from '../types'
import type { SystemToolHost } from './ports'
import { agentClassCreate, agentClassUpdate, agentClassList } from './agentClassTools'
import {
  agentInstantiate,
  agentUpdate,
  agentList,
  agentInspect,
  agentAncestry,
  agentDescendants,
  agentTerminate,
} from './agentInstanceTools'
import { mailSend, mailParticipants } from './mailTools'
import { agentPause, contextExport, contextOverview, contextRemove, contextEdit, contextApply } from './contextTools'
import { accessReply } from './accessTools'
import { telemetryQuery, formatTelemetryRow } from './telemetryTools'

export { formatTelemetryRow }

/** 生成系统工具清单（由组合根装配）。 */
export function createSystemTools(host: SystemToolHost): ToolCapability[] {
  return [
    agentClassCreate(host),
    agentClassUpdate(host),
    agentClassList(host),
    agentInstantiate(host),
    agentUpdate(host),
    agentList(host),
    agentInspect(host),
    agentAncestry(host),
    agentDescendants(host),
    agentTerminate(host),
    mailSend(host),
    mailParticipants(host),
    telemetryQuery(host),
    agentPause(host),
    contextExport(host),
    contextOverview(host),
    contextRemove(host),
    contextEdit(host),
    contextApply(host),
    accessReply(host),
  ]
}
