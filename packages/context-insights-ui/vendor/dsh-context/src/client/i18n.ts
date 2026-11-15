// KenFutWork 修改：保留组件翻译接口，语言选择由宿主提供。
export type Translate = (key: string, params?: Record<string, string | number>) => string
