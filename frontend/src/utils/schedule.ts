/**
 * 天窗可行时段判断：按负责人 / 人员 / 机具的重叠占用，生成草稿的连续可排时段，
 * 并按“重级优先、同站场连续、再排中轻级”的规则给出可排与延后病害。
 */
import type { FaultRow, InspectionRow, SwitchRow, WorkOrderRow, YardRow } from './db';
import { endTimeOf, parseDateTime } from './window';
import { FAULT_PART_LABEL, FAULT_TYPE_LABEL, type FaultSeverity } from '../types/fault';

/** 单处病害的作业耗时（分钟）：重级需连续处理，中 / 轻级可在容量不足时延后 */
export const FAULT_DURATION_MINUTES: Record<FaultSeverity, number> = {
  heavy: 60,
  medium: 45,
  light: 30,
};

const SEVERITY_RANK: Record<FaultSeverity, number> = {
  heavy: 0,
  medium: 1,
  light: 2,
};

export interface ScheduleFaultItem {
  id: string;
  severity: FaultSeverity;
  inspectionId: string;
  yardId: string;
  yardName: string;
  switchCode: string;
  inspectionDate: string;
  label: string;
}

export interface ScheduleBlocker {
  orderId: string;
  code: string;
  leader: string;
  members: string[];
  machines: string[];
  windowStart: string;
  windowEnd: string;
  occupiedLeaders: string[];
  occupiedMembers: string[];
  occupiedMachines: string[];
}

export interface ScheduleSegment {
  faultId: string;
  label: string;
  severity: FaultSeverity;
  yardName: string;
  start: string;
  end: string;
  durationMinutes: number;
}

export interface DraftScheduleInput {
  windowStart: string;
  windowEnd: string;
  leader: string;
  members: string[];
  machines: string[];
  faultIds: string[];
  editingOrderId?: string | null;
  workOrders: WorkOrderRow[];
  faults: FaultRow[];
  inspections: InspectionRow[];
  switches: SwitchRow[];
  yards: YardRow[];
}

export interface DraftScheduleResult {
  validWindow: boolean;
  heavyRequiredMinutes: number;
  totalRequiredMinutes: number;
  currentAvailableMinutes: number;
  currentSafeEnd: string | null;
  items: ScheduleFaultItem[];
  scheduledItems: ScheduleFaultItem[];
  postponedItems: ScheduleFaultItem[];
  segments: ScheduleSegment[];
  blockingItems: ScheduleFaultItem[];
  canSave: boolean;
  level: 'none' | 'success' | 'warning' | 'error';
  blockers: ScheduleBlocker[];
  /** 与实际排入时间段重叠的资源占用单 */
  currentBlockers: ScheduleBlocker[];
  /** 与整个草稿天窗重叠、但不影响当前排程的资源占用单 */
  windowBlockers: ScheduleBlocker[];
  recommendation: {
    windowStart: string;
    windowEnd: string;
    durationMinutes: number;
  } | null;
  message: string;
}

interface Interval {
  start: number;
  end: number;
}

function unique(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())))];
}

function orderResources(order: WorkOrderRow): { leaders: string[]; members: string[]; machines: string[] } {
  return {
    leaders: unique([order.leader]),
    members: unique(order.members),
    machines: unique(order.machines),
  };
}

function sharedValues(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

function blockerOf(order: WorkOrderRow, draft: Pick<DraftScheduleInput, 'leader' | 'members' | 'machines'>): ScheduleBlocker | null {
  const resources = orderResources(order);
  const occupiedLeaders = sharedValues(unique([draft.leader]), resources.leaders);
  const draftCrew = unique(draft.members);
  const occupiedMembers = unique([
    ...sharedValues(draftCrew, resources.members),
    ...sharedValues(draftCrew, resources.leaders),
    ...sharedValues(unique([draft.leader]), resources.members),
  ]);
  const occupiedMachines = sharedValues(unique(draft.machines), resources.machines);

  if (
    occupiedLeaders.length === 0 &&
    occupiedMembers.length === 0 &&
    occupiedMachines.length === 0
  ) {
    return null;
  }

  return {
    orderId: order.id,
    code: order.code,
    leader: order.leader,
    members: order.members,
    machines: order.machines,
    windowStart: order.windowStart,
    windowEnd: order.windowEnd,
    occupiedLeaders,
    occupiedMembers,
    occupiedMachines,
  };
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

function blockerIntervals(blockers: ScheduleBlocker[]): Interval[] {
  return mergeIntervals(
    blockers.map((item) => ({
      start: parseDateTime(item.windowStart),
      end: parseDateTime(item.windowEnd),
    })),
  );
}

/** 从 start 起，遇到资源占用区间后顺延，寻找可容纳 requiredMinutes 的最早连续空档 */
export function findEarliestFreeSlot(
  start: number,
  requiredMinutes: number,
  blockers: ScheduleBlocker[],
): { start: number; end: number } | null {
  if (!Number.isFinite(start) || requiredMinutes <= 0) return null;
  const requiredMs = requiredMinutes * 60000;
  const intervals = blockerIntervals(blockers);
  let cursor = start;

  for (let guard = 0; guard < intervals.length + 2; guard += 1) {
    const hit = intervals.find((interval) => interval.start < cursor + requiredMs && cursor < interval.end);
    if (!hit) return { start: cursor, end: cursor + requiredMs };
    if (hit.end <= cursor) continue;
    cursor = hit.end;
  }
  return null;
}

function formatAt(value: number): string {
  const date = new Date(value);
  const pad = (input: number): string => String(input).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

function buildItems(input: DraftScheduleInput): ScheduleFaultItem[] {
  const faultById = new Map(input.faults.map((item) => [item.id, item]));
  const inspectionById = new Map(input.inspections.map((item) => [item.id, item]));
  const switchById = new Map(input.switches.map((item) => [item.id, item]));
  const yardById = new Map(input.yards.map((item) => [item.id, item]));

  return input.faultIds
    .map((faultId) => {
      const fault = faultById.get(faultId);
      if (!fault) return null;
      const inspection = inspectionById.get(fault.inspectionId);
      const switchRow = inspection ? switchById.get(inspection.switchId) : undefined;
      const yard = switchRow ? yardById.get(switchRow.yardId) : undefined;
      if (!inspection || !switchRow) return null;
      return {
        id: fault.id,
        severity: fault.severity,
        inspectionId: inspection.id,
        yardId: switchRow.yardId,
        yardName: yard?.name ?? '未匹配站场',
        switchCode: switchRow.code,
        inspectionDate: inspection.date,
        label: `${switchRow.code} · ${FAULT_PART_LABEL[fault.part]} / ${FAULT_TYPE_LABEL[fault.type]}`,
      } satisfies ScheduleFaultItem;
    })
    .filter((item): item is ScheduleFaultItem => item !== null);
}

function orderDraftItems(items: ScheduleFaultItem[]): ScheduleFaultItem[] {
  return [...items].sort((a, b) => {
    const severityDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (severityDiff !== 0) return severityDiff;
    const yardDiff = a.yardId.localeCompare(b.yardId) || a.yardName.localeCompare(b.yardName, 'zh-Hans-CN');
    if (yardDiff !== 0) return yardDiff;
    const inspectionDiff = b.inspectionDate.localeCompare(a.inspectionDate);
    if (inspectionDiff !== 0) return inspectionDiff;
    return a.switchCode.localeCompare(b.switchCode, 'zh-Hans-CN') || a.label.localeCompare(b.label, 'zh-Hans-CN');
  });
}

function durationOfItems(items: ScheduleFaultItem[]): number {
  return items.reduce((sum, item) => sum + FAULT_DURATION_MINUTES[item.severity], 0);
}

/**
 * 重级必须优先占满连续时段；容量不足时先放弃轻级，再放弃中级。
 * 每个等级内部保持同站场连续排序，不跨级为站场连续打断重级优先。
 */
function packItems(
  items: ScheduleFaultItem[],
  start: string,
  availableMinutes: number,
): { scheduled: ScheduleFaultItem[]; postponed: ScheduleFaultItem[]; segments: ScheduleSegment[] } {
  const groups: ScheduleFaultItem[][] = [[], [], []];
  items.forEach((item) => {
    groups[SEVERITY_RANK[item.severity]].push(item);
  });

  let remaining = availableMinutes;
  const acceptedIds: string[] = [];
  const mandatoryGroups: Array<{ severity: FaultSeverity; group: ScheduleFaultItem[] }> = [
    { severity: 'heavy', group: groups[0] },
    { severity: 'medium', group: groups[1] },
  ];

  let requiredSeverity: FaultSeverity | null = null;
  for (const { severity, group } of mandatoryGroups) {
    if (group.length === 0) continue;
    for (const item of group) {
      const duration = FAULT_DURATION_MINUTES[severity];
      if (duration > remaining) {
        requiredSeverity = severity;
        break;
      }
      acceptedIds.push(item.id);
      remaining -= duration;
    }
    if (requiredSeverity) break;
  }

  if (!requiredSeverity) {
    for (const item of groups[2]) {
      const duration = FAULT_DURATION_MINUTES[item.severity];
      if (duration <= remaining) {
        acceptedIds.push(item.id);
        remaining -= duration;
      }
    }
  }

  const accepted = new Set(acceptedIds);
  let used = 0;
  const scheduled: ScheduleFaultItem[] = [];
  const postponed: ScheduleFaultItem[] = [];
  const segments: ScheduleSegment[] = [];

  items.forEach((item) => {
    if (!accepted.has(item.id)) {
      postponed.push(item);
      return;
    }
    const duration = FAULT_DURATION_MINUTES[item.severity];
    const itemStart = endTimeOf(start, used);
    used += duration;
    scheduled.push(item);
    segments.push({
      faultId: item.id,
      label: item.label,
      severity: item.severity,
      yardName: item.yardName,
      start: itemStart,
      end: endTimeOf(start, used),
      durationMinutes: duration,
    });
  });

  return { scheduled, postponed, segments };
}

/**
 * 计算当前草稿可行时段。已保存作业单只读；编辑中的作业单用 editingOrderId 排除，
 * 负责人、人员、机具任一重叠都会形成该时段的资源占用。
 */
export function evaluateDraftSchedule(input: DraftScheduleInput): DraftScheduleResult {
  const start = parseDateTime(input.windowStart);
  const end = parseDateTime(input.windowEnd);
  const validWindow = Number.isFinite(start) && Number.isFinite(end) && end > start;
  const currentDuration = validWindow ? Math.round((end - start) / 60000) : 0;
  const items = orderDraftItems(buildItems(input));

  const blockers = input.workOrders
    .filter((order) => order.id !== input.editingOrderId)
    .map((order) => blockerOf(order, input))
    .filter((item): item is ScheduleBlocker => item !== null)
    .sort((a, b) => a.windowStart.localeCompare(b.windowStart) || a.code.localeCompare(b.code));

  const intervals = blockerIntervals(blockers);
  const currentIntervals = validWindow
    ? intervals.filter((interval) => interval.start < end && start < interval.end)
    : [];
  const currentBlockerIds = new Set(
    blockers
      .filter((item) => {
        const itemStart = parseDateTime(item.windowStart);
        const itemEnd = parseDateTime(item.windowEnd);
        return validWindow && itemStart < end && start < itemEnd;
      })
      .map((item) => item.orderId),
  );
  const currentBlockers = blockers.filter((item) => currentBlockerIds.has(item.orderId));

  let availableMinutes = currentDuration;
  let currentSafeEnd: string | null = null;
  if (validWindow) {
    const firstBlockingStart = currentIntervals
      .map((interval) => interval.start)
      .find((value) => value >= start && value < end);
    if (firstBlockingStart !== undefined) {
      availableMinutes = Math.max(0, Math.round((firstBlockingStart - start) / 60000));
      currentSafeEnd = formatAt(firstBlockingStart);
    }
  }

  const packed = validWindow && items.length > 0 ? packItems(items, input.windowStart, availableMinutes) : {
    scheduled: [],
    postponed: [],
    segments: [],
  };

  const heavyMinutes = durationOfItems(items.filter((item) => item.severity === 'heavy'));
  const blockingItems = packed.postponed.filter((item) => item.severity === 'heavy');
  const reachMinutes =
    blockingItems.length > 0
      ? heavyMinutes
      : packed.scheduled.length > 0
        ? durationOfItems(packed.scheduled)
        : items.length > 0
          ? FAULT_DURATION_MINUTES[items[0].severity]
          : 0;
  const activeEnd = start + reachMinutes * 60000;
  const activeBlockerIds = new Set(
    blockers
      .filter((item) => {
        const itemStart = parseDateTime(item.windowStart);
        const itemEnd = parseDateTime(item.windowEnd);
        return validWindow && reachMinutes > 0 && itemStart < activeEnd && start < itemEnd;
      })
      .map((item) => item.orderId),
  );
  const activeBlockers = blockers.filter((item) => activeBlockerIds.has(item.orderId));
  const windowOnlyBlockers = currentBlockers.filter((item) => !activeBlockerIds.has(item.orderId));

  const canSave =
    validWindow &&
    items.length > 0 &&
    packed.scheduled.length > 0 &&
    blockingItems.length === 0;

  const totalMinutes = durationOfItems(items);
  let recommendation: DraftScheduleResult['recommendation'] = null;
  if (validWindow && items.length > 0 && (!canSave || packed.postponed.length > 0)) {
    const targetMinutes = blockingItems.length > 0 ? heavyMinutes : totalMinutes;
    const slot = findEarliestFreeSlot(start, Math.max(targetMinutes, 1), blockers);
    if (slot) {
      recommendation = {
        windowStart: formatAt(slot.start),
        windowEnd: formatAt(slot.end),
        durationMinutes: targetMinutes,
      };
    }
  }

  let level: DraftScheduleResult['level'] = 'none';
  let message = '请先选择病害。';
  if (!validWindow) {
    level = 'error';
    message = '天窗起止时间无效，无法判断可行时段。';
  } else if (items.length === 0) {
    level = 'warning';
    message = '请选择病害后计算可行时段。';
  } else if (packed.scheduled.length === 0) {
    level = 'error';
    message = '当前连续时段连首处病害都放不下，已挡住保存；请调大天窗、更换资源或应用建议时段。';
  } else if (blockingItems.length > 0) {
    level = 'error';
    message = `重级病害 ${blockingItems.length} 处排不下，已挡住保存；请调整负责人、人员、机具或应用建议时段。`;
  } else if (packed.postponed.length > 0) {
    level = 'warning';
    message = `当前连续时段可先排 ${packed.scheduled.length} 处，轻 / 中级病害 ${packed.postponed.length} 处建议延后。`;
  } else {
    level = 'success';
    message = `当前连续时段可容纳全部 ${items.length} 处病害，可保存。`;
  }

  return {
    validWindow,
    heavyRequiredMinutes: heavyMinutes,
    totalRequiredMinutes: totalMinutes,
    currentAvailableMinutes: availableMinutes,
    currentSafeEnd,
    items,
    scheduledItems: packed.scheduled,
    postponedItems: packed.postponed,
    segments: packed.segments,
    blockingItems,
    canSave,
    level,
    blockers,
    currentBlockers: activeBlockers,
    windowBlockers: windowOnlyBlockers,
    recommendation,
    message,
  };
}

/** 用于保存时只提交当前草稿能排下的病害，已保存的其它作业单不受影响 */
export function scheduledFaultIds(result: DraftScheduleResult): string[] {
  return result.scheduledItems.map((item) => item.id);
}
