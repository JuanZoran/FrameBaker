/** ZIP 读写已移至 @framebaker/shared，供服务端 adapter 转换复用；保留此入口以兼容现有导入路径。 */
export { createZip, readZip, type ZipEntry } from "@framebaker/shared";
