// 类型包 @jlceda/pro-api-types 里缺了一部分成员（比如 reset()、done()），EDA 安装目录
// resources/app/assets/pro-api/<版本>/api-types.d.ts 里有，标的是 @beta。
// 照那份声明原样补上，只补用到的。

interface IPCB_PrimitiveString {
  /** 将异步图元重置为当前画布状态 */
  reset(): Promise<IPCB_PrimitiveString>;
  /** 将对图元的更改应用到画布 */
  done(): Promise<IPCB_PrimitiveString>;
}

interface IPCB_PrimitiveAttribute {
  /** 将异步图元重置为当前画布状态 */
  reset(): Promise<IPCB_PrimitiveAttribute>;
  /** 将对图元的更改应用到画布 */
  done(): Promise<IPCB_PrimitiveAttribute>;
}
