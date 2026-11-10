/* ===================================================================
   CIERRE DIARIO - Base de datos MySQL (versión web)

   Las mismas tablas de la versión SQL Server, adaptadas a MySQL 8
   (también funciona en TiDB Cloud y MariaDB 10.5+).

   Cómo usarlo:
     1. Conéctate a tu servidor MySQL (TiDB Cloud > SQL Editor,
        MySQL Workbench, phpMyAdmin o DBeaver).
     2. Ejecuta todo este archivo.
     3. Puedes ejecutarlo más de una vez: no borra datos.

   Si tu proveedor ya te dio una base creada (por ejemplo en un hosting
   con cPanel), borra las dos líneas de CREATE DATABASE / USE y ejecuta
   el resto dentro de esa base.

   Convención de nombres:  NIO = córdobas (C$)   USD = dólares ($)
   =================================================================== */

CREATE DATABASE IF NOT EXISTS cierre_diario CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE cierre_diario;

/* 1. CIERRE: una fila por cada día (encabezado del cierre) */
CREATE TABLE IF NOT EXISTS Cierre (
    CierreId          INT            NOT NULL AUTO_INCREMENT,
    Fecha             DATE           NOT NULL,
    TasaCambio        DECIMAL(12,4)  NOT NULL,
    CapitalTrabajoUSD DECIMAL(18,2)  NOT NULL DEFAULT 0,
    Estado            VARCHAR(10)    NOT NULL DEFAULT 'ABIERTO',
    Observaciones     VARCHAR(500)   NULL,
    CreadoEn          DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ActualizadoEn     DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CerradoEn         DATETIME       NULL,
    PRIMARY KEY (CierreId),
    UNIQUE KEY UQ_Cierre_Fecha (Fecha),
    CONSTRAINT CK_Cierre_Estado CHECK (Estado IN ('ABIERTO', 'CERRADO')),
    CONSTRAINT CK_Cierre_Tasa   CHECK (TasaCambio > 0)
) ENGINE = InnoDB;

/* 2. MOVIMIENTO WU (hoja INFORMES) - una fila por cierre */
CREATE TABLE IF NOT EXISTS MovimientoWU (
    CierreId             INT           NOT NULL,
    PagosUSD             DECIMAL(18,2) NOT NULL DEFAULT 0,
    PagosNIO             DECIMAL(18,2) NOT NULL DEFAULT 0,
    EnviosUSD            DECIMAL(18,2) NOT NULL DEFAULT 0,
    EnviosNIO            DECIMAL(18,2) NOT NULL DEFAULT 0,
    BillersUSD           DECIMAL(18,2) NOT NULL DEFAULT 0,
    BillersNIO           DECIMAL(18,2) NOT NULL DEFAULT 0,
    AirpakDiaAnteriorUSD DECIMAL(18,2) NOT NULL DEFAULT 0,
    AnticipoUSD          DECIMAL(18,2) NOT NULL DEFAULT 0,
    PRIMARY KEY (CierreId),
    CONSTRAINT FK_MovimientoWU_Cierre FOREIGN KEY (CierreId) REFERENCES Cierre (CierreId) ON DELETE CASCADE
) ENGINE = InnoDB;

/* 3. BANCOS: Banco = catálogo, CierreBanco = saldo de cada día */
CREATE TABLE IF NOT EXISTS Banco (
    BancoId INT         NOT NULL AUTO_INCREMENT,
    Nombre  VARCHAR(50) NOT NULL,
    Orden   INT         NOT NULL DEFAULT 0,
    Activo  TINYINT(1)  NOT NULL DEFAULT 1,
    PRIMARY KEY (BancoId),
    UNIQUE KEY UQ_Banco_Nombre (Nombre)
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS CierreBanco (
    CierreId INT           NOT NULL,
    BancoId  INT           NOT NULL,
    SaldoUSD DECIMAL(18,2) NOT NULL DEFAULT 0,
    SaldoNIO DECIMAL(18,2) NOT NULL DEFAULT 0,
    PRIMARY KEY (CierreId, BancoId),
    CONSTRAINT FK_CierreBanco_Cierre FOREIGN KEY (CierreId) REFERENCES Cierre (CierreId) ON DELETE CASCADE,
    CONSTRAINT FK_CierreBanco_Banco  FOREIGN KEY (BancoId)  REFERENCES Banco (BancoId)
) ENGINE = InnoDB;

/* 4. CAJA FUERTE: Denominacion = billetes y monedas, CierreCajaFuerte = cuántos hay ese día */
CREATE TABLE IF NOT EXISTS Denominacion (
    DenominacionId INT           NOT NULL AUTO_INCREMENT,
    Moneda         CHAR(3)       NOT NULL,   -- NIO o USD
    Tipo           VARCHAR(10)   NOT NULL,   -- BILLETE o MONEDA
    Valor          DECIMAL(10,2) NOT NULL,
    PRIMARY KEY (DenominacionId),
    UNIQUE KEY UQ_Denominacion (Moneda, Tipo, Valor),
    CONSTRAINT CK_Denominacion_Moneda CHECK (Moneda IN ('NIO', 'USD')),
    CONSTRAINT CK_Denominacion_Tipo   CHECK (Tipo IN ('BILLETE', 'MONEDA'))
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS CierreCajaFuerte (
    CierreId       INT NOT NULL,
    DenominacionId INT NOT NULL,
    Cantidad       INT NOT NULL DEFAULT 0,
    PRIMARY KEY (CierreId, DenominacionId),
    CONSTRAINT FK_CajaFuerte_Cierre       FOREIGN KEY (CierreId)       REFERENCES Cierre (CierreId) ON DELETE CASCADE,
    CONSTRAINT FK_CajaFuerte_Denominacion FOREIGN KEY (DenominacionId) REFERENCES Denominacion (DenominacionId),
    CONSTRAINT CK_CajaFuerte_Cantidad CHECK (Cantidad >= 0)
) ENGINE = InnoDB;

/* 5. CAJAS (hoja CONTEO DE CAJAS) */
CREATE TABLE IF NOT EXISTS Cajero (
    CajeroId INT         NOT NULL AUTO_INCREMENT,
    Nombre   VARCHAR(50) NOT NULL,
    Orden    INT         NOT NULL DEFAULT 0,
    Activo   TINYINT(1)  NOT NULL DEFAULT 1,
    PRIMARY KEY (CajeroId),
    UNIQUE KEY UQ_Cajero_Nombre (Nombre)
) ENGINE = InnoDB;

CREATE TABLE IF NOT EXISTS CierreCaja (
    CierreId INT           NOT NULL,
    CajeroId INT           NOT NULL,
    MontoNIO DECIMAL(18,2) NOT NULL DEFAULT 0,
    MontoUSD DECIMAL(18,2) NOT NULL DEFAULT 0,
    PRIMARY KEY (CierreId, CajeroId),
    CONSTRAINT FK_CierreCaja_Cierre FOREIGN KEY (CierreId) REFERENCES Cierre (CierreId) ON DELETE CASCADE,
    CONSTRAINT FK_CierreCaja_Cajero FOREIGN KEY (CajeroId) REFERENCES Cajero (CajeroId)
) ENGINE = InnoDB;

/* 6. CUENTAS POR COBRAR / POR PAGAR. Tipo: C = por cobrar, P = por pagar */
CREATE TABLE IF NOT EXISTS CuentaPendiente (
    CuentaId INT           NOT NULL AUTO_INCREMENT,
    CierreId INT           NOT NULL,
    Tipo     CHAR(1)       NOT NULL,
    Nombre   VARCHAR(100)  NOT NULL,
    Monto    DECIMAL(18,2) NOT NULL,
    Moneda   CHAR(3)       NOT NULL,
    PRIMARY KEY (CuentaId),
    KEY IX_CuentaPendiente_Cierre (CierreId),
    CONSTRAINT FK_CuentaPendiente_Cierre FOREIGN KEY (CierreId) REFERENCES Cierre (CierreId) ON DELETE CASCADE,
    CONSTRAINT CK_CuentaPendiente_Tipo   CHECK (Tipo IN ('C', 'P')),
    CONSTRAINT CK_CuentaPendiente_Moneda CHECK (Moneda IN ('NIO', 'USD'))
) ENGINE = InnoDB;

/* 7. ARQUEO: los datos que se escriben a mano */
CREATE TABLE IF NOT EXISTS CierreArqueo (
    CierreId      INT           NOT NULL,
    TigoNIO       DECIMAL(18,2) NOT NULL DEFAULT 0,
    RecargasNIO   DECIMAL(18,2) NOT NULL DEFAULT 0,
    DatoAirpakUSD DECIMAL(18,2) NOT NULL DEFAULT 0,
    PRIMARY KEY (CierreId),
    CONSTRAINT FK_CierreArqueo_Cierre FOREIGN KEY (CierreId) REFERENCES Cierre (CierreId) ON DELETE CASCADE
) ENGINE = InnoDB;

/* 8. UTILIDADES. Montos MC y ventas en dólares; tarifas = C$ por cada $; renglones en córdobas */
CREATE TABLE IF NOT EXISTS CierreUtilidad (
    CierreId      INT           NOT NULL,
    MontoMC1      DECIMAL(18,2) NOT NULL DEFAULT 0,
    MontoMC2      DECIMAL(18,2) NOT NULL DEFAULT 0,
    TarifaMC      DECIMAL(8,4)  NOT NULL DEFAULT 0.29,
    VentaKen1     DECIMAL(18,2) NOT NULL DEFAULT 0,
    VentaKen2     DECIMAL(18,2) NOT NULL DEFAULT 0,
    VentaDerrik1  DECIMAL(18,2) NOT NULL DEFAULT 0,
    VentaDerrik2  DECIMAL(18,2) NOT NULL DEFAULT 0,
    TarifaVT      DECIMAL(8,4)  NOT NULL DEFAULT 0.21,
    Banpro        DECIMAL(18,2) NOT NULL DEFAULT 0,
    Bac           DECIMAL(18,2) NOT NULL DEFAULT 0,
    Dhl           DECIMAL(18,2) NOT NULL DEFAULT 0,
    Loto          DECIMAL(18,2) NOT NULL DEFAULT 0,
    ComisionesAir DECIMAL(18,2) NOT NULL DEFAULT 0,
    CambioCK      DECIMAL(18,2) NOT NULL DEFAULT 0,
    OtrosIngresos DECIMAL(18,2) NOT NULL DEFAULT 0,
    Ach           DECIMAL(18,2) NOT NULL DEFAULT 0,
    DifPorMC      DECIMAL(18,2) NOT NULL DEFAULT 0,
    PRIMARY KEY (CierreId),
    CONSTRAINT FK_CierreUtilidad_Cierre FOREIGN KEY (CierreId) REFERENCES Cierre (CierreId) ON DELETE CASCADE
) ENGINE = InnoDB;

/* 9. PARÁMETROS (pantalla Configuración) */
CREATE TABLE IF NOT EXISTS Parametro (
    Clave       VARCHAR(50)  NOT NULL,
    Valor       VARCHAR(200) NOT NULL,
    Descripcion VARCHAR(200) NULL,
    PRIMARY KEY (Clave)
) ENGINE = InnoDB;

/* 10. DATOS INICIALES (solo se agregan si todavía no existen) */
INSERT IGNORE INTO Banco (Nombre, Orden) VALUES ('BANPRO', 1), ('BAC', 2), ('LAFISE', 3), ('FICOHSA', 4);

INSERT IGNORE INTO Cajero (Nombre, Orden) VALUES ('KEN', 1), ('DERRIK', 2);

INSERT IGNORE INTO Denominacion (Moneda, Tipo, Valor) VALUES
    ('NIO', 'BILLETE',   10.00), ('NIO', 'BILLETE',   20.00), ('NIO', 'BILLETE',   50.00),
    ('NIO', 'BILLETE',  100.00), ('NIO', 'BILLETE',  200.00), ('NIO', 'BILLETE',  500.00),
    ('NIO', 'BILLETE', 1000.00),
    ('NIO', 'MONEDA',     0.50), ('NIO', 'MONEDA',     1.00), ('NIO', 'MONEDA',     5.00),
    ('USD', 'BILLETE',    1.00), ('USD', 'BILLETE',    5.00), ('USD', 'BILLETE',   10.00),
    ('USD', 'BILLETE',   20.00), ('USD', 'BILLETE',   50.00), ('USD', 'BILLETE',  100.00);

INSERT IGNORE INTO Parametro (Clave, Valor, Descripcion) VALUES
    ('NombreAgencia',     'MI AGENCIA', 'Nombre que sale en los reportes'),
    ('Direccion',         '',           'Dirección de la agencia'),
    ('Telefono',          '',           'Teléfono de la agencia'),
    ('RUC',               '',           'RUC o número de identificación'),
    ('Responsable',       '',           'Persona que firma el cierre'),
    ('TasaCambio',        '36.79',      'Tasa inicial si no hay día anterior'),
    ('CapitalTrabajoUSD', '0',          'Capital de trabajo inicial en dólares'),
    ('TarifaMC',          '0.29',       'Córdobas ganados por cada dólar de MC'),
    ('TarifaVT',          '0.21',       'Córdobas ganados por cada dólar de venta');

/* 11. COMPROBACIÓN: debe mostrar 12 tablas y los catálogos con datos */
SHOW TABLES;
SELECT * FROM Banco;
SELECT * FROM Cajero;
SELECT * FROM Denominacion ORDER BY Moneda DESC, Tipo, Valor;
