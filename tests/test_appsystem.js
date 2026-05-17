import Shell from 'gi://Shell';
const appSystem = Shell.AppSystem.get_default();
const apps = appSystem.get_installed ? appSystem.get_installed() : "no get_installed";
console.log(apps);
