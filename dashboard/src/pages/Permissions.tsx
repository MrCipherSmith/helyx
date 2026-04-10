import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { ShieldAlert, RefreshCw, Check, CheckCheck, X } from 'lucide-react'
import { api, type PendingPermission } from '../api/client'
import { useI18n } from '../i18n'

function relativeTime(date: string): string {
  const diff = (Date.now() - new Date(date).getTime()) / 1000
  if (diff < 60) return `${Math.round(diff)}s ago`
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`
  return `${Math.round(diff / 86400)}d ago`
}

const TOOL_COLORS: Record<string, string> = {
  Bash: 'bg-red-900/50 text-red-300',
  Edit: 'bg-amber-900/50 text-amber-300',
  Write: 'bg-orange-900/50 text-orange-300',
  Read: 'bg-blue-900/50 text-blue-300',
  Glob: 'bg-sky-900/50 text-sky-300',
  Grep: 'bg-cyan-900/50 text-cyan-300',
}

function ToolBadge({ tool }: { tool: string }) {
  const cls = TOOL_COLORS[tool] ?? 'bg-gray-800 text-gray-400'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-mono font-semibold ${cls}`}>
      {tool}
    </span>
  )
}

export function PermissionsPage() {
  const qc = useQueryClient()
  const { t } = useI18n()

  const { data = [], isLoading, refetch } = useQuery({
    queryKey: ['permissions-pending'],
    queryFn: () => api.pendingPermissions(),
    refetchInterval: 5_000,
  })

  const respondMutation = useMutation({
    mutationFn: ({ id, response }: { id: number; response: 'allow' | 'deny' }) =>
      api.respondPermission(id, response),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['permissions-pending'] }),
  })

  const alwaysMutation = useMutation({
    mutationFn: (id: number) => api.alwaysAllowPermission(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['permissions-pending'] }),
  })

  const isBusy = respondMutation.isPending || alwaysMutation.isPending

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ShieldAlert className="w-6 h-6 text-amber-400" />
          <h1 className="text-2xl font-bold text-white">{t('permissions.title')}</h1>
          {data.length > 0 && (
            <span className="ml-1 inline-flex items-center justify-center w-6 h-6 rounded-full bg-amber-500 text-white text-xs font-bold">
              {data.length}
            </span>
          )}
        </div>
        <button
          onClick={() => refetch()}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          {t('common.refresh')}
        </button>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="text-gray-400">{t('common.loading')}</div>
      ) : data.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-gray-500">
          <ShieldAlert className="w-12 h-12 mb-3 opacity-30" />
          <p>{t('permissions.empty')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {data.map((perm: PendingPermission) => (
            <PermissionCard
              key={perm.id}
              perm={perm}
              isBusy={isBusy}
              onAllow={() => respondMutation.mutate({ id: perm.id, response: 'allow' })}
              onAlways={() => alwaysMutation.mutate(perm.id)}
              onDeny={() => respondMutation.mutate({ id: perm.id, response: 'deny' })}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function PermissionCard({
  perm,
  isBusy,
  onAllow,
  onAlways,
  onDeny,
}: {
  perm: PendingPermission
  isBusy: boolean
  onAllow: () => void
  onAlways: () => void
  onDeny: () => void
}) {
  const { t } = useI18n()
  const project = perm.project_path?.split('/').pop() ?? perm.project_path ?? '—'
  const sessionLabel = perm.session_name ?? `#${perm.session_id}`

  return (
    <div className="bg-gray-900/60 border border-gray-800/50 rounded-xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <ToolBadge tool={perm.tool_name} />
          <span className="text-xs text-gray-500">{sessionLabel}</span>
          {perm.project_path && (
            <span className="text-xs text-gray-600 font-mono">{project}</span>
          )}
        </div>
        <span className="text-xs text-gray-600 shrink-0">{relativeTime(perm.created_at)}</span>
      </div>

      {perm.description && (
        <pre className="text-sm text-gray-300 whitespace-pre-wrap break-words font-mono bg-gray-950/60 rounded-lg p-3 max-h-40 overflow-auto">
          {perm.description}
        </pre>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          disabled={isBusy}
          onClick={onAllow}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-green-900/40 text-green-300 hover:bg-green-800/50 disabled:opacity-50 transition-colors"
        >
          <Check className="w-4 h-4" />
          {t('permissions.allow')}
        </button>
        <button
          disabled={isBusy}
          onClick={onAlways}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-blue-900/40 text-blue-300 hover:bg-blue-800/50 disabled:opacity-50 transition-colors"
        >
          <CheckCheck className="w-4 h-4" />
          {t('permissions.always')}
        </button>
        <button
          disabled={isBusy}
          onClick={onDeny}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-red-900/40 text-red-400 hover:bg-red-800/50 disabled:opacity-50 transition-colors"
        >
          <X className="w-4 h-4" />
          {t('permissions.deny')}
        </button>
      </div>
    </div>
  )
}
