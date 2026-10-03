'use strict';
// weather.js — wttr.in 天气 + 全量中文翻译表(拆分自 pet-chip.js)
const WEATHER = { txt: null, ts: 0, busy: false };
// 天气描述英→中。wttr.in 的 lang_zh 字段是坏的(请求带 lang=zh 也返回英文),只能自己翻。
// 表按 wttr.in/WWO 的全部 weatherDesc 取值写全(52 条),表里没有的再走 wxCn() 的词根兜底。
const W_ICON = {
  'Sunny': '☀️', 'Clear': '🌙', 'Partly cloudy': '⛅', 'Cloudy': '☁️', 'Overcast': '☁️',
  'Mist': '🌫️', 'Fog': '🌫️', 'Freezing fog': '🌫️',
  'Light rain': '🌦️', 'Moderate rain': '🌧️', 'Heavy rain': '🌧️', 'Torrential rain shower': '⛈️',
  'Light drizzle': '🌦️', 'Freezing drizzle': '🌧️', 'Light snow': '🌨️', 'Heavy snow': '❄️', 'Blizzard': '❄️',
  'Light sleet': '🌨️', 'Ice pellets': '🧊', 'Thunder': '⛈️', 'Haze': '😶‍🌫️', 'Sandstorm': '🌪️',
};
const W_CN = {
  'Sunny': '晴', 'Clear': '晴', 'Partly cloudy': '局部多云', 'Cloudy': '多云', 'Overcast': '阴',
  'Mist': '薄雾', 'Fog': '雾', 'Freezing fog': '冻雾', 'Haze': '霾', 'Smoke': '烟霾',
  'Dust': '浮尘', 'Sand': '沙尘', 'Duststorm': '沙尘暴', 'Sandstorm': '沙尘暴',
  // 零星/附近/可能(天气代码 39-45、51-56 那一批)
  'Patchy rain possible': '零星有雨', 'Patchy rain nearby': '附近零星有雨',
  'Patchy snow possible': '零星有雪', 'Patchy snow nearby': '附近零星有雪',
  'Patchy sleet possible': '零星雨夹雪', 'Patchy sleet nearby': '附近零星雨夹雪',
  'Patchy freezing drizzle possible': '零星冻毛毛雨', 'Patchy freezing drizzle nearby': '附近零星冻毛毛雨',
  'Patchy light drizzle': '零星毛毛雨', 'Patchy light rain': '零星小雨', 'Patchy light rain with thunder': '零星雷阵雨',
  'Patchy moderate snow': '零星中雪', 'Patchy heavy snow': '零星大雪', 'Patchy light snow': '零星小雪',
  'Thundery outbreaks possible': '可能有雷雨', 'Thundery outbreaks nearby': '附近有雷雨', 'Thundery outbreaks': '雷阵雨',
  // 毛毛雨
  'Light drizzle': '毛毛雨', 'Freezing drizzle': '冻毛毛雨', 'Heavy freezing drizzle': '强冻毛毛雨',
  // 冻雨
  'Freezing rain': '冻雨', 'Light freezing rain': '小冻雨', 'Moderate or heavy freezing rain': '强冻雨',
  // 雨
  'Light rain': '小雨', 'Moderate rain': '中雨', 'Moderate rain at times': '间歇中雨',
  'Heavy rain': '大雨', 'Heavy rain at times': '间歇大雨', 'Light rain shower': '小阵雨',
  'Moderate or heavy rain shower': '强阵雨', 'Torrential rain shower': '暴雨', 'Heavy rain with thunder': '强雷雨',
  'Light rain with thunder': '雷阵雨', 'Moderate or heavy rain with thunder': '强雷雨',
  // 雨夹雪 / 冰粒
  'Light sleet': '小雨夹雪', 'Moderate or heavy sleet': '强雨夹雪', 'Light sleet showers': '阵性雨夹雪',
  'Moderate or heavy sleet showers': '强阵性雨夹雪', 'Ice pellets': '冰粒',
  'Light showers of ice pellets': '冰粒阵雨', 'Moderate or heavy showers of ice pellets': '强冰粒阵雨',
  // 雪
  'Light snow': '小雪', 'Moderate snow': '中雪', 'Heavy snow': '大雪', 'Light snow showers': '小阵雪',
  'Moderate or heavy snow showers': '强阵雪', 'Light snow with thunder': '雷雪',
  'Moderate or heavy snow with thunder': '强雷雪', 'Blowing snow': '风吹雪', 'Blizzard': '暴风雪',
};
// 表里没有的描述:先去掉 patchy/nearby/possible/at times 这类修饰再查一次,最后按词根拼一个中文
const W_STRIP = [/\bpatchy\b/gi, '', /\bnearby\b/gi, '', /\bpossible\b/gi, '', /\bat times\b/gi, '', /\s+/g, ' '];
const W_KEY = [
  [/thunder/, '雷雨'], [/blizzard/, '暴风雪'], [/blowing snow/, '风吹雪'], [/ice pellets/, '冰粒'],
  [/freezing rain/, '冻雨'], [/freezing drizzle/, '冻毛毛雨'], [/drizzle/, '毛毛雨'],
  [/sleet/, '雨夹雪'], [/snow/, '雪'], [/torrential|heavy rain/, '大雨'], [/rain shower/, '阵雨'],
  [/rain/, '雨'], [/duststorm|sandstorm/, '沙尘暴'], [/sand|dust/, '沙尘'], [/smoke/, '烟霾'],
  [/haze/, '霾'], [/fog/, '雾'], [/mist/, '薄雾'], [/overcast/, '阴'], [/cloudy/, '多云'], [/clear|sunny/, '晴'],
];
function wxCn(desc) {
  const d = String(desc || '').trim();
  if (!d) return '';
  if (W_CN[d]) return W_CN[d];
  let s = d;
  for (const re of W_STRIP) s = s.replace(re, ' ').trim();
  if (W_CN[s]) return W_CN[s];
  for (const [re, cn] of W_KEY) {
    if (!re.test(d)) continue;
    if (/^[小中大暴]/.test(cn)) return cn;                       // 表里已带量级的直接用
    if (/\blight\b/i.test(d)) return '小' + cn;
    if (/\b(moderate|heavy|torrential)\b/i.test(d)) return (/heavy|torrential/i.test(d) ? '大' : '中') + cn;
    return cn;
  }
  return d;                                                      // 真没辙就留着英文,至少不空
}
function wxIcon(desc) {
  const d = String(desc || '').trim();
  if (W_ICON[d]) return W_ICON[d];   // 兜底正则都要 /i:wttr.in 的描述首字母大写,小写正则匹配不上
  if (/thunder/i.test(d)) return '⛈️';
  if (/blizzard|snow|ice pellets/i.test(d)) return '🌨️';
  if (/rain|drizzle|sleet|shower/i.test(d)) return '🌧️';
  if (/fog|mist|haze|smoke/i.test(d)) return '🌫️';
  if (/overcast|cloudy/i.test(d)) return '☁️';
  if (/sunny|clear/i.test(d)) return '☀️';
  if (/sand|dust/i.test(d)) return '🌪️';
  return '🌡️';
}
const W_CITY = {
  'Beijing': '北京', 'Shanghai': '上海', 'Urumqi': '乌鲁木齐', 'Guangzhou': '广州', 'Shenzhen': '深圳',
  'Chengdu': '成都', 'Hangzhou': '杭州', 'Wuhan': '武汉', "Xi'an": '西安', 'Nanjing': '南京',
  'Chongqing': '重庆', 'Tianjin': '天津', 'Suzhou': '苏州', 'Xiamen': '厦门', 'Changsha': '长沙',
  'Qingdao': '青岛', 'Dalian': '大连', 'Harbin': '哈尔滨', 'Shenyang': '沈阳', 'Kunming': '昆明',
  'Lanzhou': '兰州', 'Hefei': '合肥', 'Zhengzhou': '郑州', 'Jinan': '济南', 'Fuzhou': '福州',
  'Nanning': '南宁', 'Guiyang': '贵阳', 'Yinchuan': '银川', 'Xining': '西宁', 'Hohhot': '呼和浩特',
  'Haikou': '海口', 'Taiyuan': '太原', 'Shijiazhuang': '石家庄', 'Changchun': '长春', 'Hong Kong': '香港',
  'Macau': '澳门', 'Taipei': '台北',
};
async function refreshWeather() {
  if (WEATHER.busy || Date.now() - WEATHER.ts < 1800000) return;
  WEATHER.busy = true;
  try {
    const r = await fetch('https://wttr.in/?format=j1', { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const cur = j.current_condition && j.current_condition[0];
    const area = j.nearest_area && j.nearest_area[0];
    if (cur) {
      let desc = (cur.weatherDesc && cur.weatherDesc[0].value) || '';
      desc = desc.trim();
      const cityEn = (area && area.areaName && area.areaName[0].value) || '';
      const city = W_CITY[cityEn] || cityEn;
      const icon = wxIcon(desc);
      const cn = wxCn(desc);
      WEATHER.txt = icon + ' ' + (city ? city + ' ' : '') + cur.temp_C + '°C ' + cn;
      WEATHER.ts = Date.now();
    }
  } catch (_) { WEATHER.ts = 0; } // 失败:清零时间戳,60s 后重试
  WEATHER.busy = false;
}
module.exports = { WEATHER, refreshWeather };
