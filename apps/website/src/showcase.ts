/**
 * One small guide (add a supplier) as Steps words it, in a few of its 38 languages and its three
 * tones: the hero's step feed and the "New in 1.0" switcher show it. The wording is the app's own
 * (showcase.test.ts renders it again with the phrasebooks and fails if they differ); only the
 * labels on the recorded app's buttons are given here, translated as a localised
 * business app would show them. Kept as text so the site doesn't carry every phrasebook.
 */

export const TONES = [
  { id: "casual", label: "Casual" },
  { id: "plain", label: "Plain language" },
  { id: "formal", label: "Formal" },
] as const;
export type ShowcaseTone = (typeof TONES)[number]["id"];

/** The supplier's name typed in step 3: a name, so it stays the same in every language. */
export const SUPPLIER = "Northwind Traders";

export interface ShowcaseLanguage {
  code: string;
  /** The language's name in its own words, as Steps lists it. */
  name: string;
  /** The recorded app's labels in this language. */
  labels: { contacts: string; newSupplier: string; supplierName: string; save: string };
  steps: Record<ShowcaseTone, readonly string[]>;
}

export const SHOWCASE: readonly ShowcaseLanguage[] = [
  {
    code: "en",
    name: "English",
    labels: {
      contacts: "Contacts",
      newSupplier: "New supplier",
      supplierName: "Supplier name",
      save: "Save",
    },
    steps: {
      casual: [
        'Click "Contacts"',
        'Click "New supplier"',
        'Type "Northwind Traders" in "Supplier name" field',
        'Click "Save"',
      ],
      plain: [
        'Select "Contacts" in the menu',
        'Select the "New supplier" button',
        'Enter "Northwind Traders" in the "Supplier name" box',
        'Select the "Save" button',
      ],
      formal: [
        'Click "Contacts" on the menu.',
        'Click the "New supplier" button.',
        'In the "Supplier name" field, type "Northwind Traders".',
        'Click the "Save" button.',
      ],
    },
  },
  {
    code: "de",
    name: "Deutsch",
    labels: {
      contacts: "Kontakte",
      newSupplier: "Neuer Lieferant",
      supplierName: "Lieferantenname",
      save: "Speichern",
    },
    steps: {
      casual: [
        "„Kontakte“ anklicken",
        "„Neuer Lieferant“ anklicken",
        "„Northwind Traders“ in Feld „Lieferantenname“ eingeben",
        "„Speichern“ anklicken",
      ],
      plain: [
        "Im Menü „Kontakte“ auswählen",
        "Schaltfläche „Neuer Lieferant“ auswählen",
        "„Northwind Traders“ in das Feld „Lieferantenname“ eingeben",
        "Schaltfläche „Speichern“ auswählen",
      ],
      formal: [
        "Klicken Sie im Menü auf „Kontakte“.",
        "Klicken Sie auf die Schaltfläche „Neuer Lieferant“.",
        "Geben Sie in das Feld „Lieferantenname“ den Wert „Northwind Traders“ ein.",
        "Klicken Sie auf die Schaltfläche „Speichern“.",
      ],
    },
  },
  {
    code: "fr",
    name: "Français",
    labels: {
      contacts: "Contacts",
      newSupplier: "Nouveau fournisseur",
      supplierName: "Nom du fournisseur",
      save: "Enregistrer",
    },
    steps: {
      casual: [
        "Cliquer sur « Contacts »",
        "Cliquer sur « Nouveau fournisseur »",
        "Taper « Northwind Traders » dans le champ « Nom du fournisseur »",
        "Cliquer sur « Enregistrer »",
      ],
      plain: [
        "Sélectionnez « Contacts » dans le menu",
        "Sélectionnez le bouton « Nouveau fournisseur »",
        "Entrez « Northwind Traders » dans la zone « Nom du fournisseur »",
        "Sélectionnez le bouton « Enregistrer »",
      ],
      formal: [
        "Dans le menu, cliquez sur « Contacts ».",
        "Cliquez sur le bouton « Nouveau fournisseur ».",
        "Dans le champ « Nom du fournisseur », tapez « Northwind Traders ».",
        "Cliquez sur le bouton « Enregistrer ».",
      ],
    },
  },
  {
    code: "es",
    name: "Español",
    labels: {
      contacts: "Contactos",
      newSupplier: "Nuevo proveedor",
      supplierName: "Nombre del proveedor",
      save: "Guardar",
    },
    steps: {
      casual: [
        "Haz clic en “Contactos”",
        "Haz clic en “Nuevo proveedor”",
        "Escribe “Northwind Traders” en el campo “Nombre del proveedor”",
        "Haz clic en “Guardar”",
      ],
      plain: [
        "Selecciona “Contactos” en el menú",
        "Selecciona el botón “Nuevo proveedor”",
        "Escribe “Northwind Traders” en el cuadro “Nombre del proveedor”",
        "Selecciona el botón “Guardar”",
      ],
      formal: [
        "Haga clic en “Contactos” en el menú.",
        "Haga clic en el botón “Nuevo proveedor”.",
        "En el campo “Nombre del proveedor”, escriba “Northwind Traders”.",
        "Haga clic en el botón “Guardar”.",
      ],
    },
  },
  {
    code: "it",
    name: "Italiano",
    labels: {
      contacts: "Contatti",
      newSupplier: "Nuovo fornitore",
      supplierName: "Nome fornitore",
      save: "Salva",
    },
    steps: {
      casual: [
        "Fai clic su “Contatti”",
        "Fai clic su “Nuovo fornitore”",
        "Digita “Northwind Traders” nel campo “Nome fornitore”",
        "Fai clic su “Salva”",
      ],
      plain: [
        "Seleziona “Contatti” nel menu",
        "Seleziona il pulsante “Nuovo fornitore”",
        "Scrivi “Northwind Traders” nella casella “Nome fornitore”",
        "Seleziona il pulsante “Salva”",
      ],
      formal: [
        "Fare clic su “Contatti” nel menu.",
        "Fare clic sul pulsante “Nuovo fornitore”.",
        "Nel campo “Nome fornitore” digitare “Northwind Traders”.",
        "Fare clic sul pulsante “Salva”.",
      ],
    },
  },
  {
    code: "pt-BR",
    name: "Português (Brasil)",
    labels: {
      contacts: "Contatos",
      newSupplier: "Novo fornecedor",
      supplierName: "Nome do fornecedor",
      save: "Salvar",
    },
    steps: {
      casual: [
        "Clique em “Contatos”",
        "Clique em “Novo fornecedor”",
        "Digite “Northwind Traders” no campo “Nome do fornecedor”",
        "Clique em “Salvar”",
      ],
      plain: [
        "Selecione “Contatos” no menu",
        "Selecione o botão “Novo fornecedor”",
        "Digite “Northwind Traders” na caixa “Nome do fornecedor”",
        "Selecione o botão “Salvar”",
      ],
      formal: [
        "Clique em “Contatos” no menu.",
        "Clique no botão “Novo fornecedor”.",
        "No campo “Nome do fornecedor”, digite “Northwind Traders”.",
        "Clique no botão “Salvar”.",
      ],
    },
  },
  {
    code: "pl",
    name: "Polski",
    labels: {
      contacts: "Kontakty",
      newSupplier: "Nowy dostawca",
      supplierName: "Nazwa dostawcy",
      save: "Zapisz",
    },
    steps: {
      casual: [
        "Kliknij „Kontakty”",
        "Kliknij „Nowy dostawca”",
        "Wpisz „Northwind Traders” w polu „Nazwa dostawcy”",
        "Kliknij „Zapisz”",
      ],
      plain: [
        "Wybierz „Kontakty” w menu",
        "Wybierz przycisk „Nowy dostawca”",
        "Wpisz „Northwind Traders” w polu „Nazwa dostawcy”",
        "Wybierz przycisk „Zapisz”",
      ],
      formal: [
        "Kliknąć polecenie „Kontakty” w menu.",
        "Kliknąć przycisk „Nowy dostawca”.",
        "W polu „Nazwa dostawcy” wpisać „Northwind Traders”.",
        "Kliknąć przycisk „Zapisz”.",
      ],
    },
  },
  {
    code: "ja",
    name: "日本語",
    labels: {
      contacts: "連絡先",
      newSupplier: "新しい仕入先",
      supplierName: "仕入先名",
      save: "保存",
    },
    steps: {
      casual: [
        "「連絡先」をクリック",
        "「新しい仕入先」をクリック",
        "「仕入先名」フィールドに「Northwind Traders」と入力",
        "「保存」をクリック",
      ],
      plain: [
        "メニューの「連絡先」を選びます",
        "「新しい仕入先」ボタンを押します",
        "「仕入先名」の入力欄に「Northwind Traders」と入力します",
        "「保存」ボタンを押します",
      ],
      formal: [
        "メニューの「連絡先」をクリックします。",
        "「新しい仕入先」ボタンをクリックします。",
        "「仕入先名」ボックスに「Northwind Traders」と入力します。",
        "「保存」ボタンをクリックします。",
      ],
    },
  },
  {
    code: "zh-Hans",
    name: "简体中文",
    labels: {
      contacts: "联系人",
      newSupplier: "新建供应商",
      supplierName: "供应商名称",
      save: "保存",
    },
    steps: {
      casual: [
        "单击“联系人”",
        "单击“新建供应商”",
        "在“供应商名称”框中输入“Northwind Traders”",
        "单击“保存”",
      ],
      plain: [
        "在菜单中选择“联系人”",
        "选择“新建供应商”按钮",
        "在“供应商名称”框中输入“Northwind Traders”",
        "选择“保存”按钮",
      ],
      formal: [
        "在菜单上单击“联系人”。",
        "单击“新建供应商”按钮。",
        "在“供应商名称”框中，键入“Northwind Traders”。",
        "单击“保存”按钮。",
      ],
    },
  },
];
