import { ApiAccessError, throwPublicHttpError } from "@kenfutwork/shared";

export {
  ApiAccessError,
  ApiApplicationError,
  readPublicHttpError,
} from "@kenfutwork/shared";

export async function handleErrorResponse(response: Response): Promise<never> {
  if (response.status === 401) throw new ApiAccessError();
  return throwPublicHttpError(response);
}
