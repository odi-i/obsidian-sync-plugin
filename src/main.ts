import { App, Notice, Plugin, PluginSettingTab, requestUrl, Setting, TAbstractFile, TFolder } from 'obsidian';
import { hostname } from 'os';

interface SyncState {
   lastSyncTimestamp: Date | null;
   deviceId: string; 
   isIgnoreEvents: boolean
   vaultId?: string;
   userEmail?: string;
 }

 interface MyPluginSettings {
   userEmail: string;
 }

 const API_URL = 'http://localhost:3001'

 export default class MySyncPlugin extends Plugin {
   private state: SyncState = {
     lastSyncTimestamp: null,
     deviceId: '',
     isIgnoreEvents: false
   };
   settings: MyPluginSettings = {
      userEmail: ''
    };  
 
    async onload() {
      try {
          await this.initializePluginState();
  
          await this.loadSettings();
          this.addSettingTab(new SyncSettingsTab(this.app, this));
  
          this.setupRibbonIcon();
  
          this.registerEventHandlers();
      } catch (error) {
          console.error('Failed to initialize plugin:', error);
          new Notice('Failed to initialize sync plugin. Check console for details.');
      }
  }
  
  private async initializePluginState() {
      try {
          const data = await this.loadData();
          this.state = { ...this.state, ...data };
          
          if (!this.state.deviceId) {
              this.state.deviceId = hostname();
              await this.saveData(this.state);
          }
      } catch (error) {
          console.error('Error initializing plugin state:', error);
          this.state.deviceId = hostname();
      }
  }
  
  private setupRibbonIcon() {
      this.addRibbonIcon('sync', 'Sync Vault', async (evt: MouseEvent) => {
          new Notice('Starting manual sync...');
          try {
            //   await this.manualSync();
              new Notice('Sync completed successfully!');
          } catch (error) {
              console.error('Manual sync failed:', error);
              new Notice('Sync failed. Check console for details.');
          }
      });
  }

   private registerEventHandlers() {
      const eventHandlers = {
         create: this.handleFileCreate,
         modify: this.handleFileContentModify,
         rename: this.handleFileRename,
         delete: this.handleFileDelete
      }

      Object.entries(eventHandlers).forEach(([eventName, handler]) => {
         this.registerEvent(
            this.app.vault.on(eventName as any, (file: TAbstractFile, ...args: any[]) => {
               if (!this.state.isIgnoreEvents) {
                  handler.call(this, file, ...args);
               }
            })
         )
      })
   }

   async loadSettings() {
      this.settings = Object.assign({}, { userEmail: '' }, await this.loadData());
    }
  
   async saveSettings() {
      this.state.userEmail = this.settings.userEmail;
      await this.saveData(this.state);

      if (this.settings.userEmail) {
         await this.initializeVault();
      }
   }
    
   async initializeVault() {
      if (!this.settings.userEmail) return;
  
      try {
        const vaultResponse = await requestUrl({
          url: `${API_URL}/vaults`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: this.settings.userEmail,
          })
        });
  
        this.state.vaultId = vaultResponse.json.id;
        await this.saveData(this.state);
  
        if (vaultResponse.json.status === 'existing') {
          await this.syncFromServer();
          new Notice(`Connected to existing vault`);
        } else {
          await this.syncToServer();
          new Notice(`Created new vault with ${this.app.vault.getMarkdownFiles().length} files`);
        }
      } catch (error) {
        console.error('Vault initialization failed:', error);
        new Notice('Failed to initialize vault');
      }
   }

   async syncFromServer() {
      try {
        const response = await requestUrl({
          url: `${API_URL}/vaults/${this.state.vaultId}/files`,
          method: 'GET'
        });

        this.state.isIgnoreEvents = true;
        await this.saveData(this.state);

        this.clearVault()
        for (const fileData of response.json.files) {
         await this.ensurePathAndCreate(fileData.path, fileData.content)
        }

        this.state.lastSyncTimestamp = new Date();
        this.state.isIgnoreEvents = false;
        await this.saveData(this.state);
      } catch (error) {
        console.error('Failed to sync from server:', error);
      }
   }
    
   async ensurePathAndCreate(path: string, content: string) {
      const dirs = path.split('/').slice(0, -1);
      let currentPath = '';
      for (const dir of dirs) {
        currentPath += `${dir}/`;

        await this.app.vault.createFolder(currentPath).catch(() => {});
      }

      await this.app.vault.create(path, content);
   }

   async clearVault() {
      const allFiles = this.app.vault.getMarkdownFiles();
      const allFolders = this.app.vault.getAllFolders();

      const confirmation = confirm("Are you sure you want to clear the entire vault? This action cannot be undone.");

      if (confirmation) {
          allFiles.forEach(file => {
              this.app.vault.delete(file, false)
              .then(() => console.log(`Deleted file: ${file.name}`))
              .catch((err) => console.error(`Error deleting file: ${file.name}`, err));
          });

          allFolders.forEach(folder => {
              this.app.vault.delete(folder, true)
              .then(() => console.log(`Deleted folder: ${folder.path}`))
              .catch((err) => console.error(`Error deleting folder: ${folder.path}`, err));
          });
      }
   }
  
   async syncToServer() {
      try {
        const files = this.app.vault.getMarkdownFiles();
        const fileContents = await Promise.all(
          files.map(async (file) => ({
            path: file.path,
            content: await this.app.vault.read(file)
          }))
        );
  
        await requestUrl({
          url: `${API_URL}/vaults/${this.state.vaultId}/files`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            files: fileContents,
          })
        });

        this.state.lastSyncTimestamp = new Date();
        await this.saveData(this.state);
      } catch (error) {
        console.error('Failed to sync to server:', error);
      }
   }

   async handleFileCreate(file: TAbstractFile) {
      try {
         console.log('create');
         
         if (!this.state.vaultId || file instanceof TFolder) return;

         await requestUrl({
            url: `${API_URL}/files`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
               vaultId: this.state.vaultId,
               path: file.path,
            })
         });
      } catch (error) {
         console.error('Sync error:', error);
      }
   }

   async handleFileContentModify(file: TAbstractFile) {
      try {
         console.log('modify');

         if (!this.state.vaultId || file instanceof TFolder) return;

         const content = await this.app.vault.read(file);
         await requestUrl({
            url: `${API_URL}/files/${this.state.vaultId}/modify-content`,
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
               path: file.path,
               content: content,
            })
         });
      } catch (error) {
         console.error('Sync error:', error);
      }
   }

   async handleFileRename(file: TAbstractFile, oldPath: string) {
      try {
         console.log('rename');
         
         if (!this.state.vaultId || file instanceof TFolder) return;

         await requestUrl({
            url: `${API_URL}/files/${this.state.vaultId}/rename`,
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
               path: oldPath,
               newPath: file.path,
            })
         });
      } catch (error) {
         console.error('Sync error:', error);
      }
   }

   async handleFileDelete(file: TAbstractFile) {
      try {
         if (!this.state.vaultId || file instanceof TFolder) return;
         console.log("delete", file.path);

         const encodedPath = encodeURIComponent(file.path);
 
         await requestUrl({
             url: `${API_URL}/files/${encodedPath}`,
             method: 'DELETE',
             headers: {
                 'Vault-Id': this.state.vaultId
             }
         });
      } catch (error) {
         console.error('Sync error:', error);
      }
   }
 }

 class SyncSettingsTab extends PluginSettingTab {
   plugin: MySyncPlugin;
 
   constructor(app: App, plugin: MySyncPlugin) {
     super(app, plugin);
     this.plugin = plugin;
   }
 
   display(): void {
     const { containerEl } = this;
     containerEl.empty();
 
     new Setting(containerEl)
     .setName('Email')
     .setDesc('Your account email for sync')
     .addText(text => {
       text
         .setPlaceholder('user@example.com')
         .setValue(this.plugin.settings.userEmail)
         .onChange(async (value) => {
           this.plugin.settings.userEmail = value.trim();
         });
     })
     .addButton(button => {
       button
         .setButtonText('Save')
         .setCta()
         .onClick(async () => {
           if (!this.plugin.settings.userEmail.includes('@')) {
             new Notice('Please enter a valid email address');
             return;
           }
           
           await this.plugin.saveSettings();
           new Notice('Email saved successfully!');
         });
     });
   }
 }
