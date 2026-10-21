import { CustomPlatformInputSchema, type CustomPlatformInput } from '@nchc/core';
import { Alert, App as AntApp, Button, Form, Input, InputNumber, Segmented, Typography } from 'antd';
import { useState, type JSX } from 'react';
import { useT } from '../../i18n';
import { CUSTOM_PLATFORMS_MAX } from '../../state/state';
import { useCalc } from '../../state/store';
import { CalcDrawer } from './CalcDrawer';

type Values = {
  name?: string;
  unit: 'gpu' | 'machine';
  gpusPerNode?: number;
  memGB?: number;
  memBwTBs?: number;
  tflops?: number;
  tdpW?: number | null;
  nvlinkBidirGBs?: number | null;
  engine: 'vllm' | 'mlx';
};

/** Form values → core's CustomPlatformInput (a machine is one per node; optional fields left out when empty). */
function toPlatform(v: Values): CustomPlatformInput {
  const gpu = v.unit === 'gpu';
  return {
    name: (v.name ?? '').trim(),
    unit: v.unit,
    gpusPerNode: gpu ? v.gpusPerNode! : 1,
    memGB: v.memGB!,
    memBwTBs: v.memBwTBs!,
    tflops: v.tflops!,
    ...(typeof v.tdpW === 'number' ? { tdpW: v.tdpW } : {}),
    ...(gpu && typeof v.nvlinkBidirGBs === 'number' ? { nvlinkBidirGBs: v.nvlinkBidirGBs } : {}),
    engine: v.engine,
  };
}

const num = (min: number, step?: number) => <InputNumber<number> min={min} step={step} style={{ width: '100%' }} />;

function Body(): JSX.Element {
  const tr = useT();
  const [s, dispatch] = useCalc();
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<Values>();
  const unit = Form.useWatch('unit', form) ?? 'gpu';
  const engine = Form.useWatch('engine', form) ?? 'vllm';
  const [issues, setIssues] = useState<string[]>([]);
  const index = s.editingPlatform;
  const editing = index === null ? undefined : s.customPlatforms[index];
  const full = !editing && s.customPlatforms.length >= CUSTOM_PLATFORMS_MAX;
  const per = unit === 'gpu' ? 'gpu' : 'machine';
  const required = [{ required: true, message: tr('form.required') }];

  const submit = (v: Values) => {
    const value = toPlatform(v);
    const r = CustomPlatformInputSchema.safeParse(value);
    if (!r.success) {
      setIssues(r.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)));
      return;
    }
    setIssues([]);
    if (editing && index !== null) dispatch({ type: 'editPlatform', index, value });
    else dispatch({ type: 'addPlatform', value });
    dispatch({ type: 'dialog', id: null });
    void message.success(tr(editing ? 'hw.updated' : 'hw.added'));
  };

  return (
    <>
      {full && <Alert type="warning" showIcon style={{ marginBottom: 12 }} title={tr('hw.full', { n: CUSTOM_PLATFORMS_MAX })} />}
      {issues.length > 0 && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          title={tr('hw.issues')}
          description={issues.map((x) => (
            <div key={x}>{x}</div>
          ))}
        />
      )}
      <Form<Values>
        form={form}
        name="hardware"
        layout="vertical"
        disabled={full}
        initialValues={editing ? { ...editing, tdpW: editing.tdpW ?? null, nvlinkBidirGBs: editing.nvlinkBidirGBs ?? null } : { unit: 'gpu', engine: 'vllm' }}
        onFinish={submit}
      >
        <Form.Item name="name" label={tr('hw.name')} rules={[{ required: true, whitespace: true, message: tr('form.required') }]}>
          <Input autoComplete="off" maxLength={100} />
        </Form.Item>
        <Form.Item name="engine" label={tr('hw.engine')}>
          <Segmented<'vllm' | 'mlx'> options={[{ value: 'vllm', label: 'vLLM' }, { value: 'mlx', label: 'MLX' }]} />
        </Form.Item>
        <Form.Item name="unit" label={tr('hw.unit')}>
          <Segmented<'gpu' | 'machine'>
            options={[
              { value: 'gpu', label: tr('hw.unit.gpu') },
              { value: 'machine', label: tr('hw.unit.machine') },
            ]}
          />
        </Form.Item>
        {unit === 'gpu' && (
          <Form.Item name="gpusPerNode" label={tr('hw.gpn')} rules={required}>
            <InputNumber<number> min={1} max={8} precision={0} style={{ width: '100%' }} />
          </Form.Item>
        )}
        <Form.Item name="memGB" label={tr(`hw.mem.${per}`)} rules={required}>
          {num(0.01)}
        </Form.Item>
        <Form.Item name="memBwTBs" label={tr(`hw.bw.${per}`)} rules={required}>
          {num(0.001, 0.1)}
        </Form.Item>
        <Form.Item name="tflops" label={tr(`hw.tflops.${engine}`)} extra={tr(`hw.tflops.help.${engine}`)} rules={required}>
          {num(0.001)}
        </Form.Item>
        <Form.Item name="tdpW" label={tr(`hw.tdp.${per}`)}>
          {num(1)}
        </Form.Item>
        {unit === 'gpu' && (
          <Form.Item name="nvlinkBidirGBs" label={tr('hw.nvlink')} extra={tr('hw.nvlink.help')}>
            {num(0.1)}
          </Form.Item>
        )}
      </Form>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {tr('hw.note')}
      </Typography.Text>
    </>
  );
}

/** 「新增你的硬體」／「編輯你的硬體」(design §5.3): core's CustomPlatformInput; the row is added after the platform list. */
export function HardwareDrawer(): JSX.Element {
  const tr = useT();
  const [s] = useCalc();
  const editing = s.editingPlatform !== null && s.editingPlatform < s.customPlatforms.length;
  return (
    <CalcDrawer
      id="hardware"
      title={tr(editing ? 'hw.title.edit' : 'hw.title.add')}
      extra={
        <Button type="primary" htmlType="submit" form="hardware">
          {tr(editing ? 'hw.save' : 'hw.add')}
        </Button>
      }
    >
      <Body />
    </CalcDrawer>
  );
}
