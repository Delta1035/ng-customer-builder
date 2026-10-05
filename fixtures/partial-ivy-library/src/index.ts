/*
 * 以 `compilationMode: "partial"` 编译的测试库。
 * 产物中只包含 ɵɵngDeclare* 声明，必须经过 Angular Linker 才能在 AOT 应用里运行。
 */
export * from './greeting.service';
export * from './greeting-card';
