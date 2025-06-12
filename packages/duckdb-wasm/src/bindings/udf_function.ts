import { SQLType } from '../sql_field';

export interface UDFFunctionDeclaration {
    functionId: number;
    name: string;
    returnType: SQLType;
}

export interface UDFFunction {
    functionId: number;
    connectionId: number;
    name: string;
    returnType: SQLType;
    func: (...args: any[]) => any;
}
