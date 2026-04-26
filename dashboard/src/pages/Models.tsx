import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { useI18n } from '../i18n'

/**
 * Models page (PRD §16). Read-only listing of model_providers and
 * model_profiles. Edits/creates are deferred to a follow-up — the wizard
 * (`helyx setup` / `helyx setup-agents`) is the canonical write path
 * today, and dashboard CRUD requires PATCH/DELETE endpoints not yet on
 * the bot API. The dashboard surfaces the current state read-only so
 * operators can verify that wizard runs landed correctly.
 */
export function ModelsPage() {
  const { t } = useI18n()

  const { data: providers, isLoading: pLoading, error: pError, refetch: pRefetch } = useQuery({
    queryKey: ['providers'],
    queryFn: () => api.modelProviders(),
    staleTime: 30_000,
  })

  const { data: profiles, isLoading: prLoading, error: prError, refetch: prRefetch } = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api.modelProfiles(),
    staleTime: 30_000,
  })

  const refetchAll = () => {
    pRefetch()
    prRefetch()
  }

  if (pLoading || prLoading) return <div className="text-gray-400">{t('common.loading')}</div>
  if (pError || prError) {
    return <div className="text-red-400">{t('common.error')}: {((pError ?? prError) as Error).message}</div>
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-white">Models</h1>
        <button
          onClick={refetchAll}
          className="text-sm text-gray-400 hover:text-white px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700"
        >
          {t('common.refresh')}
        </button>
      </div>

      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
        <h2 className="text-sm font-medium text-gray-300 px-4 py-3 border-b border-gray-800">
          Model Providers ({providers?.length ?? 0})
        </h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-800/50 text-xs text-gray-400">
              <th className="text-left px-4 py-2 font-medium">#</th>
              <th className="text-left px-4 py-2 font-medium">Name</th>
              <th className="text-left px-4 py-2 font-medium">Type</th>
              <th className="text-left px-4 py-2 font-medium">Base URL</th>
              <th className="text-left px-4 py-2 font-medium">Default model</th>
              <th className="text-left px-4 py-2 font-medium">API key env</th>
              <th className="text-left px-4 py-2 font-medium">Enabled</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {(providers ?? []).map((p) => (
              <tr key={p.id} className="hover:bg-gray-800/30">
                <td className="px-4 py-2 text-gray-500 font-mono">{p.id}</td>
                <td className="px-4 py-2 text-white font-medium">{p.name}</td>
                <td className="px-4 py-2 text-gray-300 font-mono text-xs">{p.provider_type}</td>
                <td className="px-4 py-2 text-gray-400 font-mono text-xs">{p.base_url ?? '—'}</td>
                <td className="px-4 py-2 text-gray-300 font-mono text-xs">{p.default_model ?? '—'}</td>
                <td className="px-4 py-2 text-gray-400 font-mono text-xs">{p.api_key_env ?? '—'}</td>
                <td className="px-4 py-2">
                  <span className={p.enabled ? 'text-green-400' : 'text-gray-600'}>
                    {p.enabled ? 'on' : 'off'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
        <h2 className="text-sm font-medium text-gray-300 px-4 py-3 border-b border-gray-800">
          Model Profiles ({profiles?.length ?? 0})
        </h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-800/50 text-xs text-gray-400">
              <th className="text-left px-4 py-2 font-medium">#</th>
              <th className="text-left px-4 py-2 font-medium">Name</th>
              <th className="text-left px-4 py-2 font-medium">Provider</th>
              <th className="text-left px-4 py-2 font-medium">Model</th>
              <th className="text-left px-4 py-2 font-medium">Max tokens</th>
              <th className="text-left px-4 py-2 font-medium">Temp</th>
              <th className="text-left px-4 py-2 font-medium">Enabled</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {(profiles ?? []).map((p) => (
              <tr key={p.id} className="hover:bg-gray-800/30">
                <td className="px-4 py-2 text-gray-500 font-mono">{p.id}</td>
                <td className="px-4 py-2 text-white font-medium">{p.name}</td>
                <td className="px-4 py-2 text-gray-300 text-xs">{p.provider_name}</td>
                <td className="px-4 py-2 text-gray-300 font-mono text-xs">{p.model}</td>
                <td className="px-4 py-2 text-gray-400 font-mono text-xs">{p.max_tokens ?? '—'}</td>
                <td className="px-4 py-2 text-gray-400 font-mono text-xs">{p.temperature ?? '—'}</td>
                <td className="px-4 py-2">
                  <span className={p.enabled ? 'text-green-400' : 'text-gray-600'}>
                    {p.enabled ? 'on' : 'off'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-500">
        Read-only. To edit, run{' '}
        <span className="font-mono text-gray-400">helyx setup-agents</span>{' '}
        on the host or update via Telegram (planned).
      </p>
    </div>
  )
}
