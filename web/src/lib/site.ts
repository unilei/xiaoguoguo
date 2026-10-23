/**
 * 站点品牌资源与固定文案。
 *
 * 这些不是「内容」——原站的 logo、标语、页脚备案信息是站点的一部分，
 * 内容服务不提供，也不该提供。剧集数据一律走 API。
 */

const IMG = '/img';

export const ASSETS = {
  brandLogo: `${IMG}/logo-pc.5633495cb2.svg`,
  heroLogo: `${IMG}/1787571296718-urqrw994.png`,
  heroSlogan: `${IMG}/1787571296168-ufeg7zpu.png`,
  gradientMask: `${IMG}/1787571290558-4u3vfanl.png`,
  shapeMask: `${IMG}/1787571295791-gcz01e7h.png`,
  chevron: `${IMG}/1787571262443-z2a0v8r4.png`,
  footerLogo: `${IMG}/ca465a50c0d79a94c39a51676e20e4c6.png.png`,
  emptyPlay: `${IMG}/empty_play_v3.0fd69bf57ee24dc9fd38a59820508410.png`,
} as const;

/** 页脚备案信息（原站固定文案，不随内容变化）。 */
export const FOOTER_LINKS = {
  companyName: '北京笔墨留香科技有限公司',
  addressLabel: '地址 : ',
  address: '北京市门头沟区石龙经济开发区永安路20号3号楼1层128室',
  reportNotice: '违法和不良信息举报：957124',
  icpRecord: { text: '京ICP备2021028909号-43', link: 'https://beian.miit.gov.cn/' },
  icpLicense: {
    text: '京ICP证 京B2-20220790',
    link: 'https://lf3-reading.fqnovelstatic.com/obj/novel-static/c5a3df36ea956045c799f673d0400449.pdf',
  },
  webCultureLicense: {
    text: '京网文〔2025〕0222-071号',
    link: 'https://p3-novel.byteimg.com/novel-static/86cfb3f7bebd44225f9843bb7cc96a55~tplv-noop.image',
  },
  publicSecurityRecord: {
    text: '京公网安备 11010802040767',
    link: 'http://www.beian.gov.cn/portal/registerSystemInfo?recordcode=11010802040767',
  },
  businessLicense: {
    text: '营业执照',
    link: 'https://p3-novel.byteimg.com/novel-static/d01bbe200b42a33e387a8f6d65955219~tplv-noop.image',
  },
  publicationLicense: {
    text: '出版物经营许可证',
    link: 'https://p6-novel.byteimg.com/novel-static/119b8ca591731fdd8e5383fc48e1477f~tplv-noop.image',
  },
  broadcastLicense: {
    text: '广播电视节目制作经营许可证',
    link: 'https://p3-novel.byteimg.com/novel-static/3567c73e471f2bc43b7e19b7fb99817a~tplv-noop.image',
  },
  reportEmail: {
    text: 'hongguojubao@bytedance.com',
    link: 'mailto:hongguojubao@bytedance.com',
  },
} as const;

/** 分类页的四个内容类型（与原站导航一致）。 */
export const CATEGORY_TYPES = [
  { label: '真人剧', type: 'real-drama' },
  { label: '漫剧', type: 'comic-drama' },
  { label: 'AI剧', type: 'ai-drama' },
  { label: '漫画', type: 'comic' },
] as const;

/** 四个榜单。 */
export const RANK_TABS = [
  { key: 'hot-drama', label: '红果热播榜' },
  { key: 'hot-real-drama', label: '真人剧热播榜' },
  { key: 'hot-ai-drama', label: 'AI剧热播榜' },
  { key: 'hot-comic-drama', label: '漫剧热播榜' },
] as const;

export const CATEGORY_LABELS: Record<string, string> = {
  'real-drama': '真人剧',
  'comic-drama': '漫剧',
  'ai-drama': 'AI剧',
  comic: '漫画',
};

export const RANK_LABELS: Record<string, string> = {
  'hot-drama': '红果热播榜',
  'hot-real-drama': '真人剧热播榜',
  'hot-ai-drama': 'AI剧热播榜',
  'hot-comic-drama': '漫剧热播榜',
};
