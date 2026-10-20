import type zhTW from './zh-TW';

const en = {
  'mode.need': 'How much do I need',
  'mode.have': 'How much can what I have handle',
  'footer.dataVersion': 'Data version {version}',
  'sentence.users.pre': 'Up to',
  'sentence.users.post': 'people use it at the same time,',
  'sentence.have.pre': 'I have',
  'sentence.have.post': ',',
  'sentence.workload.pre': 'doing',
  'sentence.workload.post': 'tasks,',
  'sentence.model.pre': 'with the model',
  'sentence.model.post': ',',
  'sentence.quant.pre': 'at precision',
  'sentence.quant.post': ',',
  'sentence.speed.pre': 'and the response speed should be',
  'unit.gpu': 'GPUs',
  'unit.machine': 'machines',
  'aria.users': 'Concurrent users',
  'aria.haveCount': 'Count',
  'aria.platform': 'Platform',
  'aria.workload': 'Task',
  'aria.model': 'Model',
  'aria.quant': 'Precision',
  'aria.speed': 'Speed',
  'platform.desc': '{name} ({sub})',
  'model.runsOn': 'Runs on {ok} / {total} platforms',
  'model.runsNone': 'No platform can run it with the current settings',
  'model.tier': 'Suggested for this task: {tier}',
  'tag.estimate': 'Estimate',
} satisfies Record<keyof typeof zhTW, string>;

export default en;
