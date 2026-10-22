import { ModelOverrideSchema, type ModelOverride } from '@nchc/core';
import { Alert, App as AntApp, Button, Form, Input, InputNumber, Typography } from 'antd';
import { useState, type JSX } from 'react';
import { useLang, useT, type MsgKey } from '../../i18n';
import type { TFn } from '../../i18n/t';
import { useCalc } from '../../state/store';
import { CalcDrawer } from './CalcDrawer';
import { CustomModelWarning } from './CustomModelWarning';

type Num = 'totalParamsB' | 'layers' | 'heads' | 'kvHeads' | 'headDim' | 'hidden';
/** ModelOverrideSchema's required fields (a plain GQA model); the rest of the schema is for HF imports. */
const FIELDS: { key: Num; label: MsgKey; int: boolean }[] = [
  { key: 'totalParamsB', label: 'manual.params', int: false },
  { key: 'layers', label: 'manual.layers', int: true },
  { key: 'heads', label: 'manual.heads', int: true },
  { key: 'kvHeads', label: 'manual.kvHeads', int: true },
  { key: 'headDim', label: 'manual.headDim', int: true },
  { key: 'hidden', label: 'manual.hidden', int: true },
];
type Values = { name?: string } & Partial<Record<Num, number>>;
const FORM_KEYS: ReadonlySet<string> = new Set(['name', ...FIELDS.map((f) => f.key)]);

/** Labels of the ModelOverride fields this form does not edit (fix round D). */
const KEPT_LABELS: Record<string, MsgKey> = {
  hfRepo: 'manual.field.hfRepo',
  baseModel: 'manual.field.baseModel',
  origin: 'manual.field.origin',
  baseOrigin: 'manual.field.baseOrigin',
  attention: 'manual.field.attention',
  mla: 'manual.field.mla',
  layerGroups: 'manual.field.layerGroups',
  moe: 'manual.field.moe',
  slidingWindow: 'manual.field.slidingWindow',
};

/** A kept field's label in the current language; a field without one is shown by its key. */
export function keptLabel(key: string, tr: TFn): string {
  return Object.hasOwn(KEPT_LABELS, key) ? tr(KEPT_LABELS[key]!) : key;
}

function Body(): JSX.Element {
  const tr = useT();
  const [s, dispatch] = useCalc();
  const { message } = AntApp.useApp();
  const [issues, setIssues] = useState<string[]>([]);
  const lang = useLang();
  const current = s.customModel?.kind === 'manual' ? s.customModel.value : undefined;
  // Fields of the model being edited that this form does not show (moe, mla, layerGroups, slidingWindow, …): kept as
  // they are on re-save, and listed so the user knows (v8 minor 7).
  const kept = current ? Object.keys(current).filter((k) => !FORM_KEYS.has(k)) : [];
  const submit = (v: Values) => {
    const name = v.name?.trim();
    const { name: _oldName, ...rest } = current ?? {};
    const value: ModelOverride = {
      ...rest,
      ...(name ? { name } : {}),
      totalParamsB: v.totalParamsB!,
      layers: v.layers!,
      heads: v.heads!,
      kvHeads: v.kvHeads!,
      headDim: v.headDim!,
      hidden: v.hidden!,
    };
    // core's own check (head grouping, ranges); its messages are shown as they are.
    const r = ModelOverrideSchema.safeParse(value);
    if (!r.success) {
      setIssues(r.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)));
      return;
    }
    setIssues([]);
    dispatch({ type: 'customModel', value: { kind: 'manual', value } });
    dispatch({ type: 'dialog', id: null });
    void message.success(tr('manual.added'));
  };
  return (
    <>
      <CustomModelWarning />
      {issues.length > 0 && (
        <Alert
          data-testid="model-issues"
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          title={tr('manual.issues')}
          description={issues.map((x) => (
            <div key={x}>{x}</div>
          ))}
        />
      )}
      {kept.length > 0 && (
        <Alert
          data-testid="manual-kept"
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          title={tr('manual.kept', { fields: kept.map((k) => keptLabel(k, tr)).join(lang === 'en' ? ', ' : '、') })}
        />
      )}
      <Form<Values>
        name="manualModel"
        layout="vertical"
        initialValues={current ? { name: current.name, ...Object.fromEntries(FIELDS.map((f) => [f.key, current[f.key]])) } : {}}
        onFinish={submit}
      >
        <Form.Item name="name" label={tr('manual.name')}>
          <Input autoComplete="off" placeholder={tr('manual.name.ph')} />
        </Form.Item>
        {FIELDS.map(({ key, label, int }) => (
          <Form.Item key={key} name={key} label={tr(label)} rules={[{ required: true, message: tr('form.required') }]}>
            <InputNumber<number> min={int ? 1 : 0.001} precision={int ? 0 : undefined} style={{ width: '100%' }} />
          </Form.Item>
        ))}
      </Form>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {tr('manual.hint')}
      </Typography.Text>
    </>
  );
}

/** 「手動輸入模型架構」: a GQA model by its config.json numbers; checked by core's ModelOverrideSchema. */
export function ManualModelDrawer(): JSX.Element {
  const tr = useT();
  return (
    <CalcDrawer
      id="manualModel"
      title={tr('manual.title')}
      extra={
        <Button type="primary" htmlType="submit" form="manualModel">
          {tr('manual.add')}
        </Button>
      }
    >
      <Body />
    </CalcDrawer>
  );
}
