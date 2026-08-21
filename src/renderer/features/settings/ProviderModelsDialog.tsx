import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ModelInfo } from '../../../shared/contracts/ipc';
import { modelIdentity } from '../../../shared/modelVisibility';
import { ProviderLogo } from '../../components/ProviderLogo';

interface ProviderModelsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerId: string;
  title: string;
  models: readonly ModelInfo[];
  disabledModels: readonly string[];
  onDisabledModelsChange: (disabledModels: string[]) => void;
}

export function ProviderModelsDialog({
  open,
  onOpenChange,
  providerId,
  title,
  models,
  disabledModels,
  onDisabledModelsChange,
}: ProviderModelsDialogProps) {
  const hidden = new Set(disabledModels);
  const keys = models.map((model) => modelIdentity(model.provider, model.id));
  const enabledCount = keys.filter((key) => !hidden.has(key)).length;

  const setEnabled = (key: string, enabled: boolean) => {
    const next = new Set(hidden);
    if (enabled) next.delete(key);
    else next.add(key);
    onDisabledModelsChange([...next]);
  };

  const setAll = (enabled: boolean) => {
    const next = new Set(hidden);
    for (const key of keys) {
      if (enabled) next.delete(key);
      else next.add(key);
    }
    onDisabledModelsChange([...next]);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="provider-dialog-overlay" />
        <Dialog.Content className="provider-dialog-content provider-models-dialog" aria-describedby="provider-models-description">
          <div className="provider-dialog-head">
            <div className="provider-dialog-detail-head">
              <ProviderLogo providerId={providerId} size={22} />
              <div>
                <Dialog.Title className="provider-dialog-title">{title} models</Dialog.Title>
                <Dialog.Description id="provider-models-description">
                  {enabledCount} of {models.length} show in the model picker. Save settings to apply.
                </Dialog.Description>
              </div>
            </div>
            <Dialog.Close className="provider-dialog-close" aria-label="Close"><X size={15} /></Dialog.Close>
          </div>

          {models.length > 0 && (
            <div className="provider-models-actions">
              <button type="button" className="provider-dialog-retry" onClick={() => setAll(true)}>Enable all</button>
              <button type="button" className="provider-dialog-retry" onClick={() => setAll(false)}>Disable all</button>
            </div>
          )}

          <div className="provider-dialog-models" role="list" aria-label={`${title} models`}>
            {models.length === 0 && (
              <div className="provider-dialog-state"><span>This provider has no models yet.</span></div>
            )}
            {models.map((model) => {
              const key = modelIdentity(model.provider, model.id);
              const enabled = !hidden.has(key);
              return (
                <label key={key} className="provider-model-toggle settings-toggle" data-enabled={enabled || undefined}>
                  <div>
                    <strong>{model.name}</strong>
                    <small>{model.name === model.id ? `${model.reasoning ? 'Reasoning' : 'Standard'} · ${Math.round(model.contextWindow / 1000)}k` : model.id}</small>
                  </div>
                  <input
                    type="checkbox"
                    checked={enabled}
                    aria-label={`Show ${model.name} in the model picker`}
                    onChange={(event) => setEnabled(key, event.target.checked)}
                  />
                  <span aria-hidden="true" />
                </label>
              );
            })}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
