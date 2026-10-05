import { Alert, Button, Chip, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import EventAvailableIcon from '@mui/icons-material/EventAvailable';
import type { DraftScheduleResult } from '../../utils/schedule';
import { FAULT_DURATION_MINUTES } from '../../utils/schedule';
import { formatDuration } from '../../utils/window';
import { FAULT_SEVERITY_LABEL } from '../../types/fault';
import SeverityTag from '../common/SeverityTag';

interface DraftSchedulePanelProps {
  result: DraftScheduleResult;
  onApplyRecommendation: (recommendation: NonNullable<DraftScheduleResult['recommendation']>) => void;
}

const ALERT_SEVERITY = {
  none: 'info',
  success: 'success',
  warning: 'warning',
  error: 'error',
} as const;

function blockerText(blocker: DraftScheduleResult['currentBlockers'][number]): string {
  const parts: string[] = [];
  if (blocker.occupiedLeaders.length > 0) parts.push(`负责人 ${blocker.occupiedLeaders.join('、')}`);
  if (blocker.occupiedMembers.length > 0) parts.push(`人员 ${blocker.occupiedMembers.join('、')}`);
  if (blocker.occupiedMachines.length > 0) parts.push(`机具 ${blocker.occupiedMachines.join('、')}`);
  return parts.join('；');
}

export default function DraftSchedulePanel({ result, onApplyRecommendation }: DraftSchedulePanelProps) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2, bgcolor: 'grey.50' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1} mb={1} flexWrap="wrap" useFlexGap>
        <Typography variant="subtitle2" fontWeight={600}>
          可行时段判断（负责人 / 人员 / 机具占用）
        </Typography>
        <Chip size="small" label={`重 ${FAULT_DURATION_MINUTES.heavy} 分 / 中 ${FAULT_DURATION_MINUTES.medium} 分 / 轻 ${FAULT_DURATION_MINUTES.light} 分`} />
      </Stack>

      <Alert severity={ALERT_SEVERITY[result.level]} sx={{ mb: 1 }}>
        {result.message}
        {result.validWindow ? (
          <Typography component="span" variant="body2" display="block" mt={0.25}>
            当前草稿连续可排 {formatDuration(result.currentAvailableMinutes)}（至{' '}
            {result.currentSafeEnd ?? '当前天窗止'}）；重级需 {formatDuration(result.heavyRequiredMinutes)}
            {result.heavyRequiredMinutes === result.totalRequiredMinutes
              ? ''
              : `，全部病害需 ${formatDuration(result.totalRequiredMinutes)}`}
            。
          </Typography>
        ) : null}
      </Alert>

      {result.recommendation ? (
        <Alert
          severity={result.blockingItems.length > 0 ? 'error' : 'info'}
          icon={<EventAvailableIcon fontSize="inherit" />}
          action={
            <Button
              color={result.blockingItems.length > 0 ? 'error' : 'primary'}
              size="small"
              onClick={() =>
                onApplyRecommendation(result.recommendation as NonNullable<DraftScheduleResult['recommendation']>)
              }
            >
              应用建议时段
            </Button>
          }
          sx={{ mb: 1, alignItems: 'center' }}
        >
          建议改到 {result.recommendation.windowStart} ~ {result.recommendation.windowEnd.slice(-5)}（
          {formatDuration(result.recommendation.durationMinutes)}），只更新当前草稿。
        </Alert>
      ) : null}

      {result.windowBlockers.length > 0 ? (
        <Alert severity="info" sx={{ mb: 1 }}>
          {result.windowBlockers.map((blocker) => blocker.code).join('、')} 与草稿天窗尾部重叠，但不影响本次已排入作业。
        </Alert>
      ) : null}

      {result.currentBlockers.length > 0 ? (
        <Stack spacing={0.75} mb={1}>
          {result.currentBlockers.map((blocker) => (
            <Paper key={blocker.orderId} variant="outlined" sx={{ px: 1, py: 0.75 }}>
              <Typography variant="caption" display="block" fontWeight={600}>
                {blocker.code} 占用：{blocker.windowStart} ~ {blocker.windowEnd.slice(-5)}
              </Typography>
              <Typography variant="caption" color="text.secondary" display="block">
                {blockerText(blocker)}
              </Typography>
            </Paper>
          ))}
        </Stack>
      ) : null}

      {result.items.length > 0 ? (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>顺序</TableCell>
              <TableCell>等级</TableCell>
              <TableCell>站场 / 病害</TableCell>
              <TableCell>建议作业时间</TableCell>
              <TableCell align="right">判断</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {result.items.map((item, index) => {
              const segment = result.segments.find((entry) => entry.faultId === item.id);
              const postponed = !segment;
              return (
                <TableRow key={item.id} selected={!postponed} sx={postponed ? { opacity: 0.65 } : undefined}>
                  <TableCell>{index + 1}</TableCell>
                  <TableCell>
                    <SeverityTag severity={item.severity} />
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2">{item.yardName}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {item.label}（{FAULT_SEVERITY_LABEL[item.severity]}级 {FAULT_DURATION_MINUTES[item.severity]} 分）
                    </Typography>
                  </TableCell>
                  <TableCell>
                    {segment ? `${segment.start.slice(-5)} ~ ${segment.end.slice(-5)}` : '—'}
                  </TableCell>
                  <TableCell align="right">
                    <Chip
                      size="small"
                      color={postponed ? (item.severity === 'heavy' ? 'error' : 'warning') : 'success'}
                      label={postponed ? (item.severity === 'heavy' ? '阻塞保存' : '建议延后') : '连续排入'}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : null}
    </Paper>
  );
}
