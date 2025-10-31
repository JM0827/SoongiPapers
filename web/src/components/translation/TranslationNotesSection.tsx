import {
  type ReactNode,
  useState,
  useMemo,
  useCallback,
  useEffect,
} from 'react';
import {
  Pencil,
  Loader2,
  CheckCircle2,
  Circle,
  RefreshCcw,
  AlertTriangle,
  Plus,
  Trash2,
} from 'lucide-react';

import type { DocumentProfileSummary } from '../../types/domain';
import type { LocalizeFn } from '../../types/localize';
import { Collapsible } from '../common/Collapsible';

type NotesCharacterDraft = {
  id: string;
  name: string;
  targetName: string;
  age: string;
  gender: string;
  traits: string;
};

type NotesEntityDraft = {
  id: string;
  name: string;
  targetName: string;
  frequency: string;
};

type NotesPairDraft = {
  id: string;
  source: string;
  target: string;
};

type BilingualViewItem = {
  source: string;
  target: string | null;
};

type TranslationNotesDraft = {
  timePeriod: string;
  characters: NotesCharacterDraft[];
  namedEntities: NotesEntityDraft[];
  locations: NotesEntityDraft[];
  measurementUnits: NotesPairDraft[];
  linguisticFeatures: NotesPairDraft[];
};

const createCharacterDraft = (): NotesCharacterDraft => ({
  id: `character-${Math.random().toString(36).slice(2, 10)}`,
  name: '',
  targetName: '',
  age: '',
  gender: '',
  traits: '',
});

const createEntityDraft = (prefix: string): NotesEntityDraft => ({
  id: `${prefix}-${Math.random().toString(36).slice(2, 10)}`,
  name: '',
  targetName: '',
  frequency: '',
});

const createPairDraft = (prefix: string): NotesPairDraft => ({
  id: `${prefix}-${Math.random().toString(36).slice(2, 10)}`,
  source: '',
  target: '',
});

const notesToDraft = (
  notes: DocumentProfileSummary['translationNotes'] | null,
): TranslationNotesDraft => ({
  timePeriod: notes?.timePeriod ?? '',
  characters: (notes?.characters ?? []).map((character) => ({
    id: `character-${character.name}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    name: character.name,
    targetName: character.targetName ?? '',
    age: character.age ?? '',
    gender: character.gender ?? '',
    traits: (character.traits ?? []).join(', '),
  })),
  namedEntities: (notes?.namedEntities ?? []).map((entity) => ({
    id: `entity-${entity.name}-${Math.random().toString(36).slice(2, 8)}`,
    name: entity.name,
    targetName: entity.targetName ?? '',
    frequency: String(
      Number.isFinite(entity.frequency) ? entity.frequency : '',
    ),
  })),
  locations: (notes?.locations ?? []).map((location) => ({
    id: `location-${location.name}-${Math.random().toString(36).slice(2, 8)}`,
    name: location.name,
    targetName: location.targetName ?? '',
    frequency: String(
      Number.isFinite(location.frequency) ? location.frequency : '',
    ),
  })),
  measurementUnits: (notes?.measurementUnits ?? []).map((unit, index) => ({
    id: `unit-${index}-${Math.random().toString(36).slice(2, 8)}`,
    source: typeof unit === 'string' ? unit : unit.source,
    target:
      typeof unit === 'string'
        ? ''
        : unit.target !== null && unit.target !== undefined
          ? unit.target ?? ''
          : '',
  })),
  linguisticFeatures: (notes?.linguisticFeatures ?? []).map(
    (feature, index) => ({
      id: `feature-${index}-${Math.random().toString(36).slice(2, 8)}`,
      source: typeof feature === 'string' ? feature : feature.source,
      target:
        typeof feature === 'string'
          ? ''
          : feature.target !== null && feature.target !== undefined
            ? feature.target ?? ''
            : '',
    }),
  ),
});

const draftToNotes = (
  draft: TranslationNotesDraft,
): DocumentProfileSummary['translationNotes'] | null => {
  const parseTraits = (value: string) =>
    value
      .split(/[,;]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

  const characters = draft.characters
    .map((character) => {
      const name = character.name.trim();
      if (!name) return null;
      return {
        name,
        targetName: character.targetName.trim() || null,
        age: character.age.trim() || null,
        gender: character.gender.trim() || null,
        traits: parseTraits(character.traits),
      };
    })
    .filter((character): character is NonNullable<typeof character> =>
      Boolean(character),
    );

  const parseEntities = (entities: NotesEntityDraft[]) =>
    entities
      .map((entity) => {
        const name = entity.name.trim();
        if (!name) return null;
        const parsedFrequency = Number.parseInt(entity.frequency.trim(), 10);
        return {
          name,
          targetName: entity.targetName.trim() || null,
          frequency: Number.isFinite(parsedFrequency)
            ? Math.max(0, parsedFrequency)
            : 0,
        };
      })
      .filter((entity): entity is NonNullable<typeof entity> => Boolean(entity));

  const namedEntities = parseEntities(draft.namedEntities);
  const locations = parseEntities(draft.locations);
  const parsePairs = (pairs: NotesPairDraft[]) =>
    pairs
      .map((pair) => {
        const source = pair.source.trim();
        if (!source) return null;
        const target = pair.target.trim();
        return {
          source,
          target: target.length ? target : null,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  const measurementUnits = parsePairs(draft.measurementUnits);
  const linguisticFeatures = parsePairs(draft.linguisticFeatures);
  const timePeriod = draft.timePeriod.trim() || null;

  if (
    !characters.length &&
    !namedEntities.length &&
    !locations.length &&
    !measurementUnits.length &&
    !linguisticFeatures.length &&
    !timePeriod
  ) {
    return null;
  }

  return {
    characters,
    namedEntities,
    locations,
    measurementUnits,
    linguisticFeatures,
    timePeriod,
  };
};

export interface TranslationNotesSectionProps {
  notes: DocumentProfileSummary['translationNotes'] | null;
  localize: LocalizeFn;
  editable?: boolean;
  onEdit?: () => void;
  isSaving?: boolean;
  error?: string | null;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  canRefresh?: boolean;
  refreshError?: string | null;
}

export const TranslationNotesSection = ({
  notes,
  localize,
  editable = false,
  onEdit,
  isSaving = false,
  error,
  onRefresh,
  isRefreshing = false,
  canRefresh = true,
  refreshError = null,
}: TranslationNotesSectionProps) => {
  const [isOpen, setIsOpen] = useState(true);

  const titleLabel = localize(
    'rightpanel_translation_notes_title',
    'Translation notes',
  );
  const editLabel = localize(
    'rightpanel_translation_notes_edit',
    'Edit notes',
  );
  const addLabel = localize(
    'rightpanel_translation_notes_add',
    'Add notes',
  );
  const timePeriodLabel = localize(
    'rightpanel_translation_notes_time_period',
    'Time period',
  );
  const charactersLabel = localize(
    'rightpanel_translation_notes_characters',
    'Characters',
  );
  const namedEntitiesLabel = localize(
    'rightpanel_translation_notes_named_entities',
    'Named entities',
  );
  const locationsLabel = localize(
    'rightpanel_translation_notes_locations',
    'Locations',
  );
  const measurementUnitsViewLabel = localize(
    'rightpanel_translation_notes_measurement_units_view',
    'Measurement units',
  );
  const linguisticFeaturesViewLabel = localize(
    'rightpanel_translation_notes_linguistic_features_view',
    'Linguistic features',
  );
  const emptyStateMessage = localize(
    'rightpanel_translation_notes_empty',
    'Translation notes have not been documented yet. Click "${addLabel}" to capture key characters, entities, and terminology before synthesis.',
    { action: addLabel },
  );

  const normalizeBilingualView = (
    items?:
      | Array<{ source: string; target: string | null }>
      | Array<string | { source: string; target: string | null }>
      | null,
  ): BilingualViewItem[] => {
    if (!Array.isArray(items)) return [];
    return items
      .map((entry) => {
        if (typeof entry === 'string') {
          const source = entry.trim();
          if (!source) return null;
          return { source, target: null } satisfies BilingualViewItem;
        }
        const source = entry?.source?.trim();
        if (!source) return null;
        const target = entry?.target ?? null;
        return {
          source,
          target: target && target.trim().length ? target.trim() : null,
        } satisfies BilingualViewItem;
      })
      .filter((entry): entry is BilingualViewItem => Boolean(entry));
  };

  const hasPairs = (
    items?:
      | Array<{ source: string; target: string | null }>
      | Array<string | { source: string; target: string | null }>
      | null,
  ) => normalizeBilingualView(items).length > 0;

  const hasNotes = Boolean(
    notes?.timePeriod ||
      (notes?.characters?.length ?? 0) > 0 ||
      (notes?.namedEntities?.length ?? 0) > 0 ||
      (notes?.locations?.length ?? 0) > 0 ||
      hasPairs(notes?.measurementUnits) ||
      hasPairs(notes?.linguisticFeatures),
  );

  const notesStatusIcon = hasNotes ? (
    <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden="true" />
  ) : (
    <Circle className="h-4 w-4 text-slate-300" aria-hidden="true" />
  );

  const renderBilingualList = (
    items?:
      | Array<{ source: string; target: string | null }>
      | Array<string | { source: string; target: string | null }>
      | null,
  ) => {
    const normalized = normalizeBilingualView(items);
    if (!normalized.length) {
      return null;
    }
    return (
      <ul className="mt-2 space-y-2">
        {normalized.map((entry, index) => (
          <li
            key={`${entry.source}-${index}`}
            className="flex min-w-0 items-center gap-1.5 rounded border border-slate-200 bg-slate-50/60 px-3 py-1.5 text-xs text-slate-600"
          >
            <span className="truncate font-semibold text-slate-700">
              {entry.source}
            </span>
            {entry.target ? (
              <>
                <span className="text-slate-400" aria-hidden="true">
                  →
                </span>
                <span className="truncate text-slate-500">{entry.target}</span>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    );
  };

  const handleToggle = useCallback(() => {
    setIsOpen((prev) => !prev);
  }, []);

  const actionNode = (() => {
    if (editable) {
      if (isSaving) {
        return (
          <span className="flex items-center gap-1 text-xs text-slate-500">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            {localize('rightpanel_translation_notes_saving', 'Saving…')}
          </span>
        );
      }
      if (onEdit) {
        return (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100"
            onClick={onEdit}
          >
            <Pencil className="h-3 w-3" aria-hidden="true" />
            {hasNotes ? editLabel : addLabel}
          </button>
        );
      }
    }
    if (onRefresh) {
      return (
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-50"
          onClick={onRefresh}
          disabled={!canRefresh || isRefreshing}
        >
          {isRefreshing ? (
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCcw className="h-3 w-3" aria-hidden="true" />
          )}
          {localize('rightpanel_translation_notes_refresh', 'Refresh')}
        </button>
      );
    }
    return null;
  })();

  const viewContent = hasNotes ? (
    <div className="space-y-3 text-sm text-slate-600">
      {notes?.timePeriod ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            {timePeriodLabel}
          </p>
          <p className="mt-2 whitespace-pre-wrap text-slate-600">
            {notes.timePeriod}
          </p>
        </div>
      ) : null}
      {notes?.characters?.length ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            {charactersLabel}
          </p>
          <ul className="mt-2 space-y-1">
            {notes.characters.map((character) => (
              <li
                key={`character-${character.name}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-slate-200 bg-slate-50/60 px-3 py-1.5 text-xs text-slate-600"
              >
                <span className="flex min-w-0 items-center gap-2 text-sm text-slate-700">
                  <span className="truncate font-semibold">{character.name}</span>
                  {character.targetName ? (
                    <>
                      <span className="text-slate-400" aria-hidden="true">
                        →
                      </span>
                      <span className="truncate text-slate-500">
                        {character.targetName}
                      </span>
                    </>
                  ) : null}
                </span>
                {character.age ? (
                  <span className="text-[11px] text-slate-500">
                    {localize(
                      'rightpanel_translation_notes_age_label',
                      'Age: {{age}}',
                      { age: character.age },
                    )}
                  </span>
                ) : null}
                {character.gender ? (
                  <span className="text-[11px] text-slate-500">
                    {localize(
                      'rightpanel_translation_notes_gender_label',
                      'Gender: {{gender}}',
                      { gender: character.gender },
                    )}
                  </span>
                ) : null}
                {character.traits?.length ? (
                  <span className="text-[11px] text-slate-500">
                    {localize(
                      'rightpanel_translation_notes_traits_label',
                      'Traits: {{traits}}',
                      { traits: character.traits.join(', ') },
                    )}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {notes?.namedEntities?.length ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            {namedEntitiesLabel}
          </p>
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {notes.namedEntities.map((entity) => (
              <li
                key={`entity-${entity.name}`}
                className="flex min-w-0 items-center justify-between gap-2 rounded border border-slate-200 bg-slate-50/60 px-3 py-1.5 text-xs text-slate-600"
              >
                <span className="flex min-w-0 items-center gap-2 text-slate-700">
                  <span className="truncate font-semibold">{entity.name}</span>
                  {entity.targetName ? (
                    <>
                      <span className="text-slate-400" aria-hidden="true">
                        →
                      </span>
                      <span className="truncate text-slate-500">
                        {entity.targetName}
                      </span>
                    </>
                  ) : null}
                </span>
                <span className="shrink-0 text-[11px] text-slate-500">
                  {localize(
                    'rightpanel_translation_notes_frequency_label',
                    'Frequency {{count}}',
                    { count: entity.frequency ?? 0 },
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {notes?.locations?.length ? (
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            {locationsLabel}
          </p>
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {notes.locations.map((location) => (
              <li
                key={`location-${location.name}`}
                className="flex min-w-0 items-center justify-between gap-2 rounded border border-slate-200 bg-slate-50/60 px-3 py-1.5 text-xs text-slate-600"
              >
                <span className="flex min-w-0 items-center gap-2 text-slate-700">
                  <span className="truncate font-semibold">{location.name}</span>
                  {location.targetName ? (
                    <>
                      <span className="text-slate-400" aria-hidden="true">
                        →
                      </span>
                      <span className="truncate text-slate-500">
                        {location.targetName}
                      </span>
                    </>
                  ) : null}
                </span>
                <span className="shrink-0 text-[11px] text-slate-500">
                  {localize(
                    'rightpanel_translation_notes_frequency_label',
                    'Frequency {{count}}',
                    { count: location.frequency ?? 0 },
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {measurementUnitsViewLabel ? (
        normalizeBilingualView(notes?.measurementUnits).length ? (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              {measurementUnitsViewLabel}
            </p>
            {renderBilingualList(notes?.measurementUnits)}
          </div>
        ) : null
      ) : null}
      {linguisticFeaturesViewLabel ? (
        normalizeBilingualView(notes?.linguisticFeatures).length ? (
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              {linguisticFeaturesViewLabel}
            </p>
            {renderBilingualList(notes?.linguisticFeatures)}
          </div>
        ) : null
      ) : null}
    </div>
  ) : editable ? (
    <p className="text-xs text-slate-500">{emptyStateMessage}</p>
  ) : null;

  const statusMessage = useMemo(() => {
    if (refreshError) {
      return (
        <span className="flex items-center gap-1 text-xs text-rose-500">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
          {refreshError}
        </span>
      );
    }
    if (error) {
      return <span className="text-xs text-rose-500">{error}</span>;
    }
    return null;
  }, [error, refreshError]);

  return (
    <Collapsible
      title={titleLabel}
      titleAdornment={notesStatusIcon}
      isOpen={isOpen}
      onToggle={handleToggle}
      keepMounted
      action={actionNode}
    >
      {viewContent}
      {statusMessage}
    </Collapsible>
  );
};

export interface TranslationNotesEditorProps {
  notes: DocumentProfileSummary['translationNotes'] | null;
  localize: LocalizeFn;
  onSave?: (next: DocumentProfileSummary['translationNotes'] | null) => Promise<void>;
  onCancel?: () => void;
  isSaving?: boolean;
  error?: string | null;
}

export const TranslationNotesEditor = ({
  notes,
  localize,
  onSave,
  onCancel,
  isSaving = false,
  error,
}: TranslationNotesEditorProps) => {
  const SectionCard = ({
    title,
    description,
    actions,
    children,
  }: {
    title: string;
    description?: string;
    actions?: ReactNode;
    children: ReactNode;
  }) => {
    const [isOpen, setIsOpen] = useState(true);
    return (
      <Collapsible
        title={title}
        caption={description}
        isOpen={isOpen}
        onToggle={() => setIsOpen((prev) => !prev)}
        keepMounted
        showDivider={false}
        action={actions}
      >
        <div className="space-y-2">{children}</div>
      </Collapsible>
    );
  };

  const [draft, setDraft] = useState<TranslationNotesDraft>(() =>
    notesToDraft(notes),
  );
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(notesToDraft(notes));
    setFormError(null);
  }, [notes]);

  const saveLabel = localize(
    'rightpanel_translation_notes_save',
    'Save',
  );
  const savingLabel = localize(
    'rightpanel_translation_notes_saving',
    'Saving…',
  );
  const cancelLabel = localize(
    'rightpanel_translation_notes_cancel',
    'Cancel',
  );
  const addCharacterLabel = localize(
    'rightpanel_translation_notes_add_character',
    'Add character',
  );
  const addEntryLabel = localize(
    'rightpanel_translation_notes_add_entry',
    'Add',
  );
  const removeLabel = localize(
    'rightpanel_translation_notes_remove',
    'Remove',
  );
  const timePeriodLabel = localize(
    'rightpanel_translation_notes_time_period',
    'Time period',
  );
  const timePeriodPlaceholder = localize(
    'rightpanel_translation_notes_time_period_placeholder',
    'e.g., Late Joseon Dynasty',
  );
  const charactersLabel = localize(
    'rightpanel_translation_notes_characters',
    'Characters',
  );
  const characterNamePlaceholder = localize(
    'rightpanel_translation_notes_name_placeholder',
    'Name',
  );
  const characterTargetPlaceholder = localize(
    'rightpanel_translation_notes_target_placeholder',
    'Translated name',
  );
  const ageLabel = localize(
    'rightpanel_translation_notes_age_label_short',
    'Age',
  );
  const agePlaceholder = localize(
    'rightpanel_translation_notes_age_placeholder',
    'e.g., 28',
  );
  const genderLabel = localize(
    'rightpanel_translation_notes_gender_label_short',
    'Gender',
  );
  const genderPlaceholder = localize(
    'rightpanel_translation_notes_gender_placeholder',
    'e.g., Female',
  );
  const traitsLabel = localize(
    'rightpanel_translation_notes_traits_label_short',
    'Traits',
  );
  const traitsPlaceholder = localize(
    'rightpanel_translation_notes_traits_placeholder',
    'e.g., stubborn, loyal',
  );
  const noCharactersLabel = localize(
    'rightpanel_translation_notes_no_characters',
    'No characters added yet.',
  );
  const entryNamePlaceholder = localize(
    'rightpanel_translation_notes_entry_name_placeholder',
    'Name',
  );
  const entryTargetPlaceholder = localize(
    'rightpanel_translation_notes_entry_target_placeholder',
    'Translated name',
  );
  const entryFrequencyPlaceholder = localize(
    'rightpanel_translation_notes_entry_frequency_placeholder',
    'Freq',
  );
  const noEntriesLabel = localize(
    'rightpanel_translation_notes_no_entries',
    'No entries yet.',
  );
  const measurementUnitSourcePlaceholder = localize(
    'rightpanel_translation_notes_measurement_units_source_placeholder',
    'Source unit',
  );
  const measurementUnitTargetPlaceholder = localize(
    'rightpanel_translation_notes_measurement_units_target_placeholder',
    'Translated unit',
  );
  const linguisticSourcePlaceholder = localize(
    'rightpanel_translation_notes_linguistic_source_placeholder',
    'Source expression',
  );
  const linguisticTargetPlaceholder = localize(
    'rightpanel_translation_notes_linguistic_target_placeholder',
    'Translated expression',
  );
  const saveErrorFallback = localize(
    'rightpanel_translation_notes_error_save',
    'Failed to save notes.',
  );

  const addPair = (
    collection: 'measurementUnits' | 'linguisticFeatures',
    prefix: string,
  ) => {
    setDraft((prev) => ({
      ...prev,
      [collection]: [...prev[collection], createPairDraft(prefix)],
    }));
  };

  const handlePairChange = (
    collection: 'measurementUnits' | 'linguisticFeatures',
    id: string,
    field: 'source' | 'target',
    value: string,
  ) => {
    setDraft((prev) => ({
      ...prev,
      [collection]: prev[collection].map((entry) =>
        entry.id === id ? { ...entry, [field]: value } : entry,
      ),
    }));
  };

  const handlePairRemove = (
    collection: 'measurementUnits' | 'linguisticFeatures',
    id: string,
  ) => {
    setDraft((prev) => ({
      ...prev,
      [collection]: prev[collection].filter((entry) => entry.id !== id),
    }));
  };

  const handleCancel = useCallback(() => {
    setDraft(notesToDraft(notes));
    setFormError(null);
    onCancel?.();
  }, [notes, onCancel]);

  const renderPairList = (
    items: NotesPairDraft[],
    collection: 'measurementUnits' | 'linguisticFeatures',
    sourcePlaceholder: string,
    targetPlaceholder: string,
  ) => (
    <div className="space-y-2">
      {items.length ? (
        <div className="space-y-2">
          {items.map((item) => (
            <div
              key={item.id}
              className="grid gap-2 rounded border border-slate-200 bg-slate-50/70 p-2 md:grid-cols-[1fr,1fr,auto]"
            >
              <input
                value={item.source}
                onChange={(event) =>
                  handlePairChange(
                    collection,
                    item.id,
                    'source',
                    event.target.value,
                  )
                }
                className="flex-1 rounded border border-slate-200 px-2 py-1.5 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
                placeholder={sourcePlaceholder}
                aria-label={localize(
                  'rightpanel_translation_notes_source_label',
                  'Source',
                )}
              />
              <input
                value={item.target}
                onChange={(event) =>
                  handlePairChange(
                    collection,
                    item.id,
                    'target',
                    event.target.value,
                  )
                }
                className="flex-1 rounded border border-slate-200 px-2 py-1.5 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
                placeholder={targetPlaceholder}
                aria-label={localize(
                  'rightpanel_translation_notes_target_label',
                  'Translation',
                )}
              />
              <button
                type="button"
                className="rounded p-1 text-rose-500 transition hover:text-rose-600 disabled:opacity-60"
                onClick={() => handlePairRemove(collection, item.id)}
                disabled={isSaving}
                title={removeLabel}
                aria-label={removeLabel}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                <span className="sr-only">{removeLabel}</span>
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-slate-500">{noEntriesLabel}</p>
      )}
    </div>
  );

  const handleSave = async () => {
    if (!onSave) {
      onCancel?.();
      return;
    }
    try {
      await onSave(draftToNotes(draft));
      setFormError(null);
      onCancel?.();
    } catch (err) {
      const message = err instanceof Error && err.message
        ? err.message
        : saveErrorFallback;
      setFormError(message);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          className="rounded border border-slate-200 px-3 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 disabled:opacity-60"
          onClick={handleCancel}
          disabled={isSaving}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          className="rounded bg-slate-800 px-3 py-1 text-xs font-medium text-white transition hover:bg-slate-700 disabled:opacity-60"
          onClick={handleSave}
          disabled={isSaving}
        >
          {isSaving ? savingLabel : saveLabel}
        </button>
      </div>
      <SectionCard
        title={localize('rightpanel_translation_notes_context', 'Narrative context')}
        description={localize(
          'rightpanel_translation_notes_context_hint',
          'Summaries, measurement units, and linguistic cues that downstream translators must follow.',
        )}
      >
        <div className="space-y-2">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            {timePeriodLabel}
          </label>
          <input
            value={draft.timePeriod}
            onChange={(event) =>
              setDraft((prev) => ({
                ...prev,
                timePeriod: event.target.value,
              }))
            }
            className="w-full rounded border border-slate-200 px-2.5 py-1.5 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
            placeholder={timePeriodPlaceholder}
          />
        </div>
      </SectionCard>
      <SectionCard
        title={charactersLabel}
        description={localize(
          'rightpanel_translation_notes_characters_hint',
          'Capture key characters with both source and translated references.',
        )}
        actions={
          <button
            type="button"
            className="rounded border border-slate-200 p-1 text-slate-600 transition hover:bg-slate-100 disabled:opacity-60"
            onClick={() =>
              setDraft((prev) => ({
                ...prev,
                characters: [...prev.characters, createCharacterDraft()],
              }))
            }
            disabled={isSaving}
            title={addCharacterLabel}
            aria-label={addCharacterLabel}
            data-collapsible-ignore
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">{addCharacterLabel}</span>
          </button>
        }
      >
        {draft.characters.length ? (
          <div className="space-y-2.5">
            {draft.characters.map((character, index) => (
              <div key={character.id} className="rounded border border-slate-200 p-2.5">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-slate-600">
                    {localize(
                      'rightpanel_translation_notes_character_label',
                      `Character #${index + 1}`,
                      { index: index + 1 },
                    )}
                  </p>
                  <button
                    type="button"
                    className="rounded p-1 text-rose-500 transition hover:text-rose-600 disabled:opacity-60"
                    onClick={() =>
                      setDraft((prev) => ({
                        ...prev,
                        characters: prev.characters.filter(
                          (entry) => entry.id !== character.id,
                        ),
                      }))
                    }
                    disabled={isSaving}
                    title={removeLabel}
                    aria-label={removeLabel}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                    <span className="sr-only">{removeLabel}</span>
                  </button>
                </div>
                <div className="mt-2.5 grid gap-2.5 md:grid-cols-2">
                  <div className="space-y-1">
                    <label className="block text-[11px] uppercase tracking-wide text-slate-500">
                      {localize('rightpanel_translation_notes_name', 'Name')}
                    </label>
                    <input
                      value={character.name}
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          characters: prev.characters.map((entry) =>
                            entry.id === character.id
                              ? { ...entry, name: event.target.value }
                              : entry,
                          ),
                        }))
                      }
                      className="w-full rounded border border-slate-200 px-2.5 py-1.5 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
                      placeholder={characterNamePlaceholder}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-[11px] uppercase tracking-wide text-slate-500">
                      {localize('rightpanel_translation_notes_target_name', 'Translated name')}
                    </label>
                    <input
                      value={character.targetName}
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          characters: prev.characters.map((entry) =>
                            entry.id === character.id
                              ? { ...entry, targetName: event.target.value }
                              : entry,
                          ),
                        }))
                      }
                      className="w-full rounded border border-slate-200 px-2.5 py-1.5 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
                      placeholder={characterTargetPlaceholder}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-[11px] uppercase tracking-wide text-slate-500">
                      {ageLabel}
                    </label>
                    <input
                      value={character.age}
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          characters: prev.characters.map((entry) =>
                            entry.id === character.id
                              ? { ...entry, age: event.target.value }
                              : entry,
                          ),
                        }))
                      }
                      className="w-full rounded border border-slate-200 px-2.5 py-1.5 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
                      placeholder={agePlaceholder}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-[11px] uppercase tracking-wide text-slate-500">
                      {genderLabel}
                    </label>
                    <input
                        value={character.gender}
                        onChange={(event) =>
                          setDraft((prev) => ({
                            ...prev,
                            characters: prev.characters.map((entry) =>
                              entry.id === character.id
                                ? { ...entry, gender: event.target.value }
                                : entry,
                            ),
                          }))
                        }
                        className="w-full rounded border border-slate-200 px-2.5 py-1.5 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
                        placeholder={genderPlaceholder}
                      />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-[11px] uppercase tracking-wide text-slate-500">
                      {traitsLabel}
                    </label>
                    <input
                      value={character.traits}
                      onChange={(event) =>
                        setDraft((prev) => ({
                          ...prev,
                          characters: prev.characters.map((entry) =>
                            entry.id === character.id
                              ? { ...entry, traits: event.target.value }
                              : entry,
                          ),
                        }))
                      }
                      className="w-full rounded border border-slate-200 px-2.5 py-1.5 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
                      placeholder={traitsPlaceholder}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-500">{noCharactersLabel}</p>
        )}
      </SectionCard>
      <SectionCard
        title={localize('rightpanel_translation_notes_named_entities', 'Named entities')}
        actions={
          <button
            type="button"
            className="rounded border border-slate-200 p-1 text-slate-600 transition hover:bg-slate-100 disabled:opacity-60"
            onClick={() =>
              setDraft((prev) => ({
                ...prev,
                namedEntities: [...prev.namedEntities, createEntityDraft('entity')],
              }))
            }
            disabled={isSaving}
            title={addEntryLabel}
            aria-label={addEntryLabel}
            data-collapsible-ignore
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">{addEntryLabel}</span>
          </button>
        }
      >
        {draft.namedEntities.length ? (
          <div className="space-y-2.5">
            {draft.namedEntities.map((entity) => (
              <div key={entity.id} className="grid gap-2.5 md:grid-cols-[1fr,1fr,120px,auto]">
                <input
                  value={entity.name}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      namedEntities: prev.namedEntities.map((entry) =>
                        entry.id === entity.id
                          ? { ...entry, name: event.target.value }
                          : entry,
                      ),
                    }))
                  }
                  className="rounded border border-slate-200 px-2.5 py-1.5 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
                  placeholder={entryNamePlaceholder}
                />
                <input
                  value={entity.targetName}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      namedEntities: prev.namedEntities.map((entry) =>
                        entry.id === entity.id
                          ? { ...entry, targetName: event.target.value }
                          : entry,
                      ),
                    }))
                  }
                  className="rounded border border-slate-200 px-2.5 py-1.5 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
                  placeholder={entryTargetPlaceholder}
                />
                <input
                  value={entity.frequency}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      namedEntities: prev.namedEntities.map((entry) =>
                        entry.id === entity.id
                          ? { ...entry, frequency: event.target.value }
                          : entry,
                      ),
                    }))
                  }
                  className="rounded border border-slate-200 px-2.5 py-1.5 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
                  placeholder={entryFrequencyPlaceholder}
                />
                <button
                  type="button"
                  className="rounded p-1 text-rose-500 transition hover:text-rose-600 disabled:opacity-60"
                  onClick={() =>
                    setDraft((prev) => ({
                      ...prev,
                      namedEntities: prev.namedEntities.filter(
                        (entry) => entry.id !== entity.id,
                      ),
                    }))
                  }
                  disabled={isSaving}
                  title={removeLabel}
                  aria-label={removeLabel}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  <span className="sr-only">{removeLabel}</span>
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-500">{noEntriesLabel}</p>
        )}
      </SectionCard>
      <SectionCard
        title={localize('rightpanel_translation_notes_locations', 'Locations')}
        actions={
          <button
            type="button"
            className="rounded border border-slate-200 p-1 text-slate-600 transition hover:bg-slate-100 disabled:opacity-60"
            onClick={() =>
              setDraft((prev) => ({
                ...prev,
                locations: [...prev.locations, createEntityDraft('location')],
              }))
            }
            disabled={isSaving}
            title={addEntryLabel}
            aria-label={addEntryLabel}
            data-collapsible-ignore
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">{addEntryLabel}</span>
          </button>
        }
      >
        {draft.locations.length ? (
          <div className="space-y-2.5">
            {draft.locations.map((location) => (
              <div key={location.id} className="grid gap-2.5 md:grid-cols-[1fr,1fr,120px,auto]">
                <input
                  value={location.name}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      locations: prev.locations.map((entry) =>
                        entry.id === location.id
                          ? { ...entry, name: event.target.value }
                          : entry,
                      ),
                    }))
                  }
                  className="rounded border border-slate-200 px-2.5 py-1.5 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
                  placeholder={entryNamePlaceholder}
                />
                <input
                  value={location.targetName}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      locations: prev.locations.map((entry) =>
                        entry.id === location.id
                          ? { ...entry, targetName: event.target.value }
                          : entry,
                      ),
                    }))
                  }
                  className="rounded border border-slate-200 px-2.5 py-1.5 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
                  placeholder={entryTargetPlaceholder}
                />
                <input
                  value={location.frequency}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      locations: prev.locations.map((entry) =>
                        entry.id === location.id
                          ? { ...entry, frequency: event.target.value }
                          : entry,
                      ),
                    }))
                  }
                  className="rounded border border-slate-200 px-2.5 py-1.5 text-sm text-slate-700 focus:border-slate-400 focus:outline-none"
                  placeholder={entryFrequencyPlaceholder}
                />
                <button
                  type="button"
                  className="rounded p-1 text-rose-500 transition hover:text-rose-600 disabled:opacity-60"
                  onClick={() =>
                    setDraft((prev) => ({
                      ...prev,
                      locations: prev.locations.filter(
                        (entry) => entry.id !== location.id,
                      ),
                    }))
                  }
                  disabled={isSaving}
                  title={removeLabel}
                  aria-label={removeLabel}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  <span className="sr-only">{removeLabel}</span>
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-500">{noEntriesLabel}</p>
        )}
      </SectionCard>
      <SectionCard
        title={localize('rightpanel_translation_notes_measurement_units', 'Measurement units')}
        actions={
          <button
            type="button"
            className="rounded border border-slate-200 p-1 text-slate-600 transition hover:bg-slate-100 disabled:opacity-60"
            onClick={() => addPair('measurementUnits', 'unit')}
            disabled={isSaving}
            title={addEntryLabel}
            aria-label={addEntryLabel}
            data-collapsible-ignore
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">{addEntryLabel}</span>
          </button>
        }
      >
        {renderPairList(
          draft.measurementUnits,
          'measurementUnits',
          measurementUnitSourcePlaceholder,
          measurementUnitTargetPlaceholder,
        )}
      </SectionCard>
      <SectionCard
        title={localize('rightpanel_translation_notes_linguistic_features', 'Linguistic features')}
        actions={
          <button
            type="button"
            className="rounded border border-slate-200 p-1 text-slate-600 transition hover:bg-slate-100 disabled:opacity-60"
            onClick={() => addPair('linguisticFeatures', 'feature')}
            disabled={isSaving}
            title={addEntryLabel}
            aria-label={addEntryLabel}
            data-collapsible-ignore
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">{addEntryLabel}</span>
          </button>
        }
      >
        {renderPairList(
          draft.linguisticFeatures,
          'linguisticFeatures',
          linguisticSourcePlaceholder,
          linguisticTargetPlaceholder,
        )}
      </SectionCard>
      {(formError || error) && (
        <p className="text-xs text-rose-500">{formError || error || ''}</p>
      )}
    </div>
  );
};
