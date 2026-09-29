// 类型包 @jlceda/pro-api-types 只收 @public 成员。下面这些在 EDA 安装目录
// resources/app/assets/pro-api/<版本>/api-types.d.ts 里标的是 @beta，类型包里被裁掉了，
// 照那份声明原样补上，只补用到的。

interface IPCB_PrimitiveString {
  /** 将对图元的更改应用到画布 */
  done(): Promise<IPCB_PrimitiveString>;
}

interface IPCB_PrimitiveAttribute {
  /** 将对图元的更改应用到画布 */
  done(): Promise<IPCB_PrimitiveAttribute>;
}
