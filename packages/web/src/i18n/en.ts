import type zhTW from './zh-TW';

const en = {
  'mode.need': 'How much do I need',
  'mode.have': 'How much can what I have handle',
  'footer.dataVersion': 'Data version {version}',
} satisfies Record<keyof typeof zhTW, string>;

export default en;
