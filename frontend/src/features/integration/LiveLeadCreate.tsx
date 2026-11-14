import { useRef, useState, type FormEvent } from 'react'
import { Plus, X } from 'lucide-react'
import { ApiClientError, type ApiClient } from '../../core/api/apiClient'
import './LiveLeadCreate.css'

type Role = 'MANAGER' | 'EMPLOYEE'
type Choice = { optionKey: string; label: string; isActive: boolean }
type CustomField = { fieldKey: string; label: string; fieldType: string; required: boolean }
type FormSchema = {
    status: Choice[]
    priority: Choice[]
    fields: CustomField[]
    choiceFields: Record<string, Choice[]>
}

const textTypes = ['text', 'textarea', 'email', 'phone', 'url', 'date']
const numberTypes = ['number', 'integer', 'decimal', 'currency']
const boolTypes = ['boolean', 'checkbox']
const selectTypes = ['select', 'dropdown', 'radio']
const supportedTypes = [...textTypes, ...numberTypes, ...boolTypes, ...selectTypes]

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function isChoice(value: unknown): value is Choice {
    return record(value) && typeof value.optionKey === 'string' &&
        /^[a-z][a-z0-9_]*$/.test(value.optionKey) && typeof value.label === 'string' &&
        value.isActive === true
}
function isField(value: unknown): value is CustomField {
    return record(value) && typeof value.fieldKey === 'string' &&
        /^[a-z][a-z0-9_]*$/.test(value.fieldKey) && typeof value.label === 'string' &&
        typeof value.fieldType === 'string' && typeof value.required === 'boolean'
}
function apiData(payload: unknown): unknown {
    if (!record(payload) || payload.success !== true || !('data' in payload)) {
        throw new Error('Unexpected CRM configuration response; no Lead will be saved.')
    }
    return payload.data
}

async function fetchSchema(client: ApiClient): Promise<FormSchema> {
    const metadata = apiData(await client.request<unknown>({
        path: 'customization/leads/form?picklists=status,priority', method: 'GET',
    }))
    if (!record(metadata) || !Array.isArray(metadata.fields) || !record(metadata.picklists)) {
        throw new Error('Lead configuration is not available.')
    }
    if (!Array.isArray(metadata.picklists.status) || !Array.isArray(metadata.picklists.priority)) {
        throw new Error('Lead status and priority must be configured by the Owner.')
    }
    // Fail closed rather than silently accept an unfamiliar field or choice type.
    if (!metadata.fields.every(isField) ||
        !metadata.picklists.status.every(isChoice) ||
        !metadata.picklists.priority.every(isChoice)) {
        throw new Error('Unexpected Lead field or choice configuration.')
    }
    const fields: CustomField[] = metadata.fields
    if (fields.some(field => !supportedTypes.includes(field.fieldType))) {
        throw new Error('Unsupported custom Lead field type. Configure a supported field before saving.')
    }
    const choiceFields: Record<string, Choice[]> = {}
    for (const field of fields) {
        if (selectTypes.includes(field.fieldType)) {
            const raw = apiData(await client.request<unknown>({
                path: `customization/leads/options/${encodeURIComponent(field.fieldKey)}`,
                method: 'GET',
            }))
            if (!Array.isArray(raw) || !raw.every(isChoice)) {
                throw new Error(`Could not verify choices for ${field.label}.`)
            }
            choiceFields[field.fieldKey] = raw
        }
    }
    const status: Choice[] = metadata.picklists.status
    const priority: Choice[] = metadata.picklists.priority
    if (!status.length || !priority.length) {
        throw new Error('No active Lead status or priority choices are configured.')
    }
    return { status, priority, fields, choiceFields }
}

/** This is local-development-only; the production sign-in and write UI remain separate. */
export default function LiveLeadCreate({
    client, role, actorUserId, onCreated,
}: {
    client: ApiClient
    role: Role
    actorUserId: string
    onCreated: () => void
}) {
    const dialog = useRef<HTMLDialogElement>(null)
    const submitting = useRef(false)
    const [schema, setSchema] = useState<FormSchema | null>(null)
    const [loading, setLoading] = useState(false)
    const [title, setTitle] = useState('')
    const [status, setStatus] = useState('')
    const [priority, setPriority] = useState('')
    const [description, setDescription] = useState('')
    const [ownerId, setOwnerId] = useState(actorUserId)
    const [custom, setCustom] = useState<Record<string, string | boolean>>({})
    const [error, setError] = useState('')
    const [success, setSuccess] = useState('')
    const [saving, setSaving] = useState(false)

    if (!import.meta.env.DEV) return null

    async function open() {
        setError(''); setSuccess(''); setSchema(null); setLoading(true)
        setTitle(''); setDescription(''); setOwnerId(actorUserId); setCustom({})
        dialog.current?.showModal()
        try {
            const next = await fetchSchema(client)
            setSchema(next)
            setStatus(next.status[0]?.optionKey ?? '')
            setPriority(next.priority[0]?.optionKey ?? '')
        } catch (problem: unknown) {
            setError(problem instanceof Error ? problem.message : 'Unable to load company Lead configuration.')
        } finally { setLoading(false) }
    }
    function close() {
        if (saving) return
        dialog.current?.close()
    }
    function prepareCustomValues(definitions: CustomField[]): Record<string, unknown> {
        const values: Record<string, unknown> = {}
        for (const field of definitions) {
            const raw = custom[field.fieldKey]
            if (boolTypes.includes(field.fieldType)) {
                // Unchecked boolean is a valid false, including when required.
                values[field.fieldKey] = raw === true
                continue
            }
            if ((raw === undefined || raw === '') && !field.required) continue
            if (field.required && (raw === undefined || raw === '')) {
                throw new Error(`Required field missing: ${field.label}`)
            }
            if (numberTypes.includes(field.fieldType)) {
                const numeric = Number(raw)
                if (!Number.isFinite(numeric) || (field.fieldType === 'integer' && !Number.isSafeInteger(numeric))) {
                    throw new Error(`Enter a valid number for ${field.label}`)
                }
                values[field.fieldKey] = numeric
            } else {
                values[field.fieldKey] = raw
            }
        }
        return values
    }
    async function save(event: FormEvent<HTMLFormElement>) {
        event.preventDefault()
        if (submitting.current || !schema || loading) return
        setError(''); setSuccess('')
        if (!title.trim() || title.trim().length > 200) { setError('Enter a Lead title (up to 200 characters).'); return }
        if (!schema.status.some(x => x.optionKey === status) || !schema.priority.some(x => x.optionKey === priority)) {
            setError('Choose configured status and priority values.'); return
        }
        const finalOwner = role === 'EMPLOYEE' ? actorUserId : ownerId.trim()
        if (!/^[1-9][0-9]*$/.test(finalOwner)) { setError('Enter a valid CRM owner user ID.'); return }
        let customValues: Record<string, unknown>
        try { customValues = prepareCustomValues(schema.fields) }
        catch (problem) { setError(problem instanceof Error ? problem.message : 'Invalid custom field.'); return }
        submitting.current = true
        setSaving(true)
        try {
            const result = apiData(await client.request<unknown>({
                path: 'leads', method: 'POST',
                body: { title: title.trim(), status, priority, description: description.trim() || null,
                    ownerUserId: finalOwner, customValues },
            }))
            if (!record(result) || typeof result.id !== 'string' || !/^[1-9][0-9]*$/.test(result.id)) {
                throw new Error('The API returned an unrecognized create result. Check the list before retrying.')
            }
            setSuccess(`Lead #${result.id} saved. The Leads list is refreshing.`)
            onCreated()
            dialog.current?.close()
        } catch (problem: unknown) {
            const code = problem instanceof ApiClientError ? problem.status : undefined
            if (code === 403) setError('The backend denied this owner or Lead permission (HTTP 403).')
            else if (code === 400 || code === 422) setError('The backend rejected a field, choice, or required value. Check company configuration.')
            else if (code === 409) setError('A conflicting Lead already exists (HTTP 409). Check the list before retrying.')
            else setError('Save outcome is not confirmed. Check the Leads list before retrying to avoid duplicates.')
        } finally { submitting.current = false; setSaving(false) }
    }
    return (
        <>
            <button className="leads-create-button" type="button" onClick={() => { void open() }}>
                <Plus size={17} aria-hidden="true" /> New Lead
            </button>
            <dialog className="live-create-dialog" ref={dialog} onCancel={event => { if (saving) event.preventDefault() }}>
                <div className="live-create-heading">
                    <div><h2>Create Lead</h2><p>Real Save · Local CRM database · {role === 'MANAGER' ? 'Manager' : 'Employee'}</p></div>
                    <button type="button" onClick={close} disabled={saving} aria-label="Close Lead form"><X size={20}/></button>
                </div>
                {loading && <p role="status">Loading company field configuration…</p>}
                {error && <p className="live-create-error" role="alert">{error}</p>}
                {success && <p role="status">{success}</p>}
                {!loading && schema && (
                    <form onSubmit={event => { void save(event) }} className="live-create-form">
                        <label>Lead title *<input required maxLength={200} value={title}
                            onChange={event => setTitle(event.target.value)} placeholder="Example: Fictional demo enquiry" /></label>
                        <div className="live-create-two">
                            <label>Status *<select required value={status} onChange={event => setStatus(event.target.value)}>
                                {schema.status.map(x => <option key={x.optionKey} value={x.optionKey}>{x.label}</option>)}
                            </select></label>
                            <label>Priority *<select required value={priority} onChange={event => setPriority(event.target.value)}>
                                {schema.priority.map(x => <option key={x.optionKey} value={x.optionKey}>{x.label}</option>)}
                            </select></label>
                        </div>
                        {role === 'MANAGER' && (
                            <label>Assign to user ID (yourself or a permitted team employee)
                                <input required inputMode="numeric" pattern="[1-9][0-9]*" value={ownerId}
                                    onChange={event => setOwnerId(event.target.value)} />
                                <small>Your user ID is {actorUserId}. Use employee ID 3 only for the current local test team. The backend checks team membership.</small>
                            </label>
                        )}
                        {schema.fields.map(field => (
                            <label key={field.fieldKey}>{field.label}{field.required ? ' *' : ''}
                                {selectTypes.includes(field.fieldType) ? (
                                    <select required={field.required} value={String(custom[field.fieldKey] ?? '')}
                                        onChange={event => setCustom(p => ({ ...p, [field.fieldKey]: event.target.value }))}>
                                        <option value="">Select…</option>
                                        {(schema.choiceFields[field.fieldKey] ?? []).map(x => (
                                            <option key={x.optionKey} value={x.optionKey}>{x.label}</option>
                                        ))}
                                    </select>
                                ) : boolTypes.includes(field.fieldType) ? (
                                    <input type="checkbox" checked={custom[field.fieldKey] === true}
                                        onChange={event => setCustom(p => ({ ...p, [field.fieldKey]: event.target.checked }))} />
                                ) : field.fieldType === 'textarea' ? (
                                    <textarea required={field.required} value={String(custom[field.fieldKey] ?? '')}
                                        onChange={event => setCustom(p => ({ ...p, [field.fieldKey]: event.target.value }))} />
                                ) : (
                                    <input required={field.required}
                                        type={field.fieldType === 'date' ? 'date' : numberTypes.includes(field.fieldType) ? 'number' : field.fieldType === 'email' ? 'email' : field.fieldType === 'url' ? 'url' : 'text'}
                                        step={field.fieldType === 'integer' ? '1' : numberTypes.includes(field.fieldType) ? 'any' : undefined}
                                        value={String(custom[field.fieldKey] ?? '')}
                                        onChange={event => setCustom(p => ({ ...p, [field.fieldKey]: event.target.value }))} />
                                )}
                            </label>
                        ))}
                        <label>Notes / description<textarea maxLength={10000} value={description}
                            onChange={event => setDescription(event.target.value)} placeholder="Optional notes" /></label>
                        <p className="live-create-note">The existing preview's contact name, phone and email are not part of this backend Lead-creation contract. This form saves a Lead; Contacts will be connected separately.</p>
                        <div className="live-create-actions">
                            <button type="button" onClick={close} disabled={saving}>Cancel</button>
                            <button className="leads-create-button" type="submit" disabled={saving}>
                                {saving ? 'Saving Lead…' : 'Save Lead to CRM'}
                            </button>
                        </div>
                    </form>
                )}
            </dialog>
        </>
    )
}
