/**
 * Estimation settings: the on-device model, the optional external endpoint,
 * and meal photos.
 *
 * The app is fully usable with neither model. The on-device model downloads
 * only on explicit consent, over Wi-Fi where the browser can tell. The
 * external endpoint is off until configured -- there is no default, no
 * suggested provider and no shipped key -- and what it is sent is stated
 * here and before first use.
 */

import { useEffect, useState } from 'preact/hooks'
import {
  ON_DEVICE_MODELS,
  checkDevice,
  connectionForDownload,
  deleteModel,
  isDownloaded,
  loadModel,
  modelIdFor,
  type DeviceCapability,
} from '../../estimate/onDevice.ts'
import { endpointProblem } from '../../estimate/external.ts'
import * as repo from '../../data/repositories.ts'
import * as store from '../store.ts'
import { EXTERNAL_DISCLOSURE } from '../estimateTiers.ts'
import { Meter, Sheet } from './common.tsx'

export function EstimationSettings(props: { onChanged: () => void }) {
  return (
    <div class="card">
      <div class="card-title">Estimation</div>
      <div class="faint" style="margin-bottom:10px">
        For meals with no label, recipe or scale. Optional: every other way of
        logging works with no model at all.
      </div>
      <OnDevice />
      <div class="divider" />
      <External />
      <div class="divider" />
      <Photos onChanged={props.onChanged} />
    </div>
  )
}

function OnDevice() {
  const settings = store.settings.value
  const id = settings.onDeviceModelId
  const [present, setPresent] = useState<boolean | undefined>(undefined)
  const [capability, setCapability] = useState<DeviceCapability | undefined>(undefined)
  const [consent, setConsent] = useState(false)
  const [progress, setProgress] = useState<{ fraction: number; text: string } | undefined>(undefined)
  const [problem, setProblem] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (id) void isDownloaded(id).then(setPresent)
    else setPresent(false)
  }, [id])

  async function prepare(): Promise<void> {
    setProblem(undefined)
    const c = await checkDevice()
    setCapability(c)
    if (c.ok) setConsent(true)
  }

  async function download(chosen: string): Promise<void> {
    setConsent(false)
    setProgress({ fraction: 0, text: 'Starting…' })
    try {
      await loadModel(chosen, (fraction, text) => setProgress({ fraction, text }))
      const next = { ...store.settings.value, onDeviceModelId: chosen }
      await repo.saveSettings(next)
      store.settings.value = next
      setPresent(true)
      store.notify('The on-device model is ready.')
    } catch {
      setProblem(
        'The download did not finish. Nothing is lost — the app works without it, and it can be tried again.',
      )
    } finally {
      setProgress(undefined)
    }
  }

  async function remove(): Promise<void> {
    if (!id) return
    try {
      await deleteModel(id)
    } catch {
      // The cache may already be gone; forget the model either way.
    }
    const { onDeviceModelId: _drop, ...rest } = store.settings.value
    await repo.saveSettings(rest)
    store.settings.value = rest
    setPresent(false)
    store.notify('The on-device model was removed.')
  }

  const modelLabel = id
    ? Object.values(ON_DEVICE_MODELS).find((m) => m.id === id || m.idF32 === id)?.label ?? id
    : undefined

  return (
    <div style="display:flex;flex-direction:column;gap:8px">
      <div class="row-between">
        <span>On this device</span>
        <span class="faint">
          {present ? `${modelLabel} · ready` : id && present === false ? 'not downloaded' : 'off'}
        </span>
      </div>
      <div class="faint">
        Meta's Llama 3.2, running in this browser on the graphics chip. Nothing
        leaves the device after the download. Expect reasonable results on
        common dishes and weaker ones on unusual dishes — a small model recalls
        quantities less well than a large one.
      </div>
      {progress ? (
        <Meter pct={progress.fraction * 100} label={progress.text} />
      ) : present ? (
        <button class="btn btn-small btn-ghost" onClick={() => void remove()}>
          Remove the model
        </button>
      ) : (
        <button
          class="btn btn-small"
          disabled={store.offline.value}
          onClick={() => void prepare()}
        >
          Set up the on-device model
        </button>
      )}
      {store.offline.value && !present && (
        <div class="faint">Offline mode is on, so nothing can be downloaded.</div>
      )}
      {capability && !capability.ok && <div class="notice">{capability.reason}</div>}
      {problem && <div class="notice">{problem}</div>}
      {consent && capability?.ok && (
        <DownloadConsent
          capability={capability}
          onCancel={() => setConsent(false)}
          onAccept={(chosen) => void download(chosen)}
        />
      )}
    </div>
  )
}

function DownloadConsent(props: {
  capability: Extract<DeviceCapability, { ok: true }>
  onCancel: () => void
  onAccept: (id: string) => void
}) {
  const { capability } = props
  const model = ON_DEVICE_MODELS[capability.size]
  const id = modelIdFor(capability.size, capability.f16)
  const connection = connectionForDownload()
  return (
    <Sheet title="Download the on-device model" onClose={props.onCancel}>
      <div>
        <strong>{model.label}</strong> — about {model.approxGb} GB, downloaded
        once and kept in this browser's private storage.
      </div>
      <div class="faint">{capability.reason}</div>
      {connection === 'cellular' ? (
        <div class="notice">
          This looks like a mobile-data or data-saver connection. Connect to
          Wi-Fi first; the download is too large for a data plan.
        </div>
      ) : connection === 'unknown' ? (
        <div class="notice">
          This browser does not say what connection it is on. Download only
          over Wi-Fi.
        </div>
      ) : (
        <div class="faint">On Wi-Fi.</div>
      )}
      <div class="faint">
        The download comes from the model's publisher. It can be removed here at
        any time, and the app works the same without it.
      </div>
      <div class="row" style="gap:8px">
        <button class="btn btn-ghost" onClick={props.onCancel}>
          Not now
        </button>
        <button
          class="btn btn-primary"
          style="flex:1"
          disabled={connection === 'cellular'}
          onClick={() => props.onAccept(id)}
        >
          Download {model.approxGb} GB
        </button>
      </div>
    </Sheet>
  )
}

function External() {
  const existing = store.externalEndpoint.value
  const [editing, setEditing] = useState(false)
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '')
  const [model, setModel] = useState(existing?.model ?? '')
  const [apiKey, setApiKey] = useState(existing?.apiKey ?? '')
  const problem = baseUrl.trim() === '' ? undefined : endpointProblem({ baseUrl, model })

  async function save(): Promise<void> {
    if (problem || baseUrl.trim() === '') return
    await repo.saveExternalEndpoint({
      id: 'external',
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      apiKey: apiKey.trim(),
      enabled: existing?.enabled ?? true,
      // A changed endpoint is a different recipient: ask again.
      ...(existing?.disclosureAcceptedAt !== undefined && existing.baseUrl === baseUrl.trim()
        ? { disclosureAcceptedAt: existing.disclosureAcceptedAt }
        : {}),
    })
    await store.refreshExternalEndpoint()
    setEditing(false)
    store.notify('Endpoint saved.')
  }

  async function toggle(enabled: boolean): Promise<void> {
    if (!existing) return
    await repo.saveExternalEndpoint({ ...existing, enabled })
    await store.refreshExternalEndpoint()
  }

  async function remove(): Promise<void> {
    await repo.clearExternalEndpoint()
    await store.refreshExternalEndpoint()
    setBaseUrl('')
    setModel('')
    setApiKey('')
    setEditing(false)
    store.notify('Endpoint removed, key included.')
  }

  return (
    <div style="display:flex;flex-direction:column;gap:8px">
      <div class="row-between">
        <span>Your own endpoint</span>
        <span class="faint">
          {!existing ? 'not set up' : existing.enabled ? existing.model : 'off'}
        </span>
      </div>
      <div class="faint">
        Optional, and off until you set it up. Any service that speaks the
        OpenAI-compatible chat-completions format. A large hosted model
        estimates better than the on-device one and can use a photo.
      </div>

      {existing && !editing && (
        <>
          <label class="toggle">
            <span>Use it for estimates</span>
            <input
              type="checkbox"
              checked={existing.enabled}
              onChange={(e) => void toggle((e.target as HTMLInputElement).checked)}
            />
          </label>
          <div class="row" style="gap:8px">
            <button class="btn btn-small" onClick={() => setEditing(true)}>
              Change
            </button>
            <button class="btn btn-small btn-ghost" onClick={() => void remove()}>
              Remove
            </button>
          </div>
        </>
      )}

      {(editing || !existing) &&
        (editing ? (
          <>
            <label>
              Base URL
              <input
                type="url"
                value={baseUrl}
                placeholder="https://…/v1"
                onInput={(e) => setBaseUrl((e.target as HTMLInputElement).value)}
              />
            </label>
            <label>
              Model name
              <input
                type="text"
                value={model}
                onInput={(e) => setModel((e.target as HTMLInputElement).value)}
              />
            </label>
            <label>
              API key
              <input
                type="password"
                value={apiKey}
                autoComplete="off"
                onInput={(e) => setApiKey((e.target as HTMLInputElement).value)}
              />
            </label>
            <div class="faint">
              The key is kept in this browser's IndexedDB, not a hardware-backed
              keystore, and is never included in a backup.
            </div>
            {problem && <div class="notice">{problem}</div>}
            <div class="row" style="gap:8px">
              <button class="btn btn-small btn-ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button
                class="btn btn-small btn-primary"
                disabled={problem !== undefined || baseUrl.trim() === ''}
                onClick={() => void save()}
              >
                Save
              </button>
            </div>
          </>
        ) : (
          <button class="btn btn-small btn-ghost" onClick={() => setEditing(true)}>
            Set up an endpoint
          </button>
        ))}

      <details class="faint">
        <summary>What is sent</summary>
        {EXTERNAL_DISCLOSURE} If the endpoint fails — no network, a bad key, a
        rate limit — the estimate falls back to the on-device model, then to
        entering it by hand. Offline mode turns the endpoint off.
      </details>
    </div>
  )
}

function Photos(props: { onChanged: () => void }) {
  const settings = store.settings.value
  const [confirm, setConfirm] = useState(false)

  async function setRetain(retain: boolean): Promise<void> {
    const next = { ...store.settings.value, retainPhotos: retain }
    await repo.saveSettings(next)
    store.settings.value = next
  }

  async function deleteAll(): Promise<void> {
    const n = await repo.deleteAllPhotos()
    setConfirm(false)
    props.onChanged()
    store.notify(n === 0 ? 'There were no photos.' : `${n} photo${n === 1 ? '' : 's'} deleted.`)
  }

  return (
    <div style="display:flex;flex-direction:column;gap:8px">
      <label class="toggle">
        <span>Keep meal photos with their entries</span>
        <input
          type="checkbox"
          checked={settings.retainPhotos !== false}
          onChange={(e) => void setRetain((e.target as HTMLInputElement).checked)}
        />
      </label>
      <div class="faint">
        Photos are only possible with your own endpoint, are only sent on an
        Estimate tap, and are stored on this device, compressed, for
        correcting an estimate later. They are not part of a backup.
      </div>
      {confirm ? (
        <div class="row" style="gap:8px">
          <button class="btn btn-small btn-primary" onClick={() => void deleteAll()}>
            Delete every photo
          </button>
          <button class="btn btn-small btn-ghost" onClick={() => setConfirm(false)}>
            Keep them
          </button>
        </div>
      ) : (
        <button class="btn btn-small btn-ghost" onClick={() => setConfirm(true)}>
          Delete all photos
        </button>
      )}
    </div>
  )
}
