import { useTranslation } from 'react-i18next'
import { X, Monitor } from 'lucide-react'
import DeviceStream from '@/components/DeviceStream'
import type { AgentGroup } from '@/lib/types'

interface Props {
  group: AgentGroup
  onClose: () => void
}

export function GroupStreamDialog({ group, onClose }: Props) {
  const { t } = useTranslation()

  const streamableMembers = group.members.filter((m) => m.device_identifier)
  const nonStreamableMembers = group.members.filter((m) => !m.device_identifier)
  const totalMembers = group.members.length

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/90">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 bg-black/60 px-5 py-3">
        <div className="flex items-center gap-2">
          <Monitor className="size-4 text-primary" />
          <h2 className="text-sm font-semibold text-white">{t('agentGroups.groupStream')}</h2>
          <span className="text-sm text-white/50">— {group.name}</span>
        </div>
        <button
          onClick={onClose}
          className="rounded p-1.5 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          aria-label={t('common.cancel')}
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Stream grid */}
      <div className="flex-1 overflow-auto p-3">
        {group.members.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-white/50">{t('agentGroups.groupStreamNoDevices')}</p>
          </div>
        ) : (
          <div
            className="grid h-full gap-2"
            style={{
              gridTemplateColumns: `repeat(${Math.ceil(Math.sqrt(Math.max(totalMembers, 1)))}, minmax(0, 1fr))`,
            }}
          >
            {streamableMembers.map((member) => (
              <div
                key={member.id}
                className="flex flex-col overflow-hidden rounded-lg border border-white/10 bg-black"
                style={{ minHeight: '200px' }}
              >
                <div className="flex shrink-0 items-center gap-1.5 border-b border-white/10 px-2 py-1">
                  <span
                    className={`size-1.5 rounded-full ${
                      member.device_status === 'online'
                        ? 'bg-green-500'
                        : member.device_status === 'connected'
                          ? 'bg-blue-500'
                          : 'bg-white/30'
                    }`}
                  />
                  <span className="truncate text-xs font-medium text-white/80">{member.device_name}</span>
                </div>
                <div className="flex-1 overflow-hidden">
                  <DeviceStream identifier={member.device_identifier} />
                </div>
              </div>
            ))}
            {nonStreamableMembers.map((member) => (
              <div
                key={member.id}
                className="flex flex-col items-center justify-center gap-2 rounded-lg border border-white/10 bg-black/50 p-4 text-center"
                style={{ minHeight: '200px' }}
              >
                <Monitor className="size-8 text-white/20" strokeWidth={1} />
                <span className="text-xs font-medium text-white/60">{member.device_name}</span>
                <span className="text-xs text-white/30">{t('agentGroups.groupStreamNoIdentifier')}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
